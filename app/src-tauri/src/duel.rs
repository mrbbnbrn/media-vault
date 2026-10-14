//! Duel mode: two pictures side by side, you pick the better one. Each pick
//! updates both items' Elo rating (stored in `media.elo`, empty = 1000) and
//! their duel count, and sets their slideshow weight from the rating, so
//! "Weighted random" shows your favourites more often.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub const START_ELO: f64 = 1000.0;
const K: f64 = 32.0;

/// One item's ranking state (also what an undo puts back).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DuelState {
    pub id: i64,
    pub elo: f64,
    pub duels: i64,
    pub weight: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DuelOutcome {
    pub winner_elo: f64,
    pub loser_elo: f64,
    pub winner_weight: f64,
    pub loser_weight: f64,
    /// Both items as they were before this duel (winner first), for undo.
    pub before: Vec<DuelState>,
}

/// Chance that a player rated `a` beats one rated `b`.
pub fn expected(a: f64, b: f64) -> f64 {
    1.0 / (1.0 + 10f64.powf((b - a) / 400.0))
}

/// Slideshow weight for a rating: doubles every 200 points above 1000.
pub fn weight_for(elo: f64) -> f64 {
    let w = 2f64.powf((elo - START_ELO) / 200.0).clamp(0.25, 20.0);
    (w * 100.0).round() / 100.0
}

/// New ratings (winner, loser) after one duel.
pub fn rate(winner: f64, loser: f64) -> (f64, f64) {
    let e = expected(winner, loser);
    (winner + K * (1.0 - e), loser - K * (1.0 - e))
}

fn state(c: &Connection, id: i64) -> Result<DuelState, String> {
    c.query_row("SELECT id, elo, duels, weight FROM media WHERE id = ?1", params![id], |r| {
        Ok(DuelState {
            id: r.get(0)?,
            elo: r.get::<_, Option<f64>>(1)?.unwrap_or(START_ELO),
            duels: r.get(2)?,
            weight: r.get(3)?,
        })
    })
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "That item is no longer in the library.".to_string())
}

/// Ratings of these items (missing ids are left out).
pub fn ratings(c: &Connection, ids: &[i64]) -> Result<Vec<DuelState>, String> {
    let mut out = Vec::with_capacity(ids.len());
    for &id in ids {
        if let Ok(s) = state(c, id) {
            out.push(s);
        }
    }
    Ok(out)
}

fn write(c: &Connection, s: &DuelState, elo: Option<f64>) -> Result<(), String> {
    c.execute("UPDATE media SET elo = ?1, duels = ?2, weight = ?3 WHERE id = ?4", params![elo, s.duels, s.weight, s.id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Record one duel: `winner` was picked over `loser`.
pub fn result(c: &Connection, winner: i64, loser: i64) -> Result<DuelOutcome, String> {
    if winner == loser {
        return Err("A duel needs two different items.".into());
    }
    let w = state(c, winner)?;
    let l = state(c, loser)?;
    let (we, le) = rate(w.elo, l.elo);
    let nw = DuelState { id: winner, elo: we, duels: w.duels + 1, weight: weight_for(we) };
    let nl = DuelState { id: loser, elo: le, duels: l.duels + 1, weight: weight_for(le) };
    write(c, &nw, Some(we))?;
    write(c, &nl, Some(le))?;
    Ok(DuelOutcome { winner_elo: we, loser_elo: le, winner_weight: nw.weight, loser_weight: nl.weight, before: vec![w, l] })
}

/// Put items back as they were (undo). A rating of exactly 1000 with no
/// duels is stored as empty again, like an item that never duelled.
pub fn restore(c: &Connection, states: &[DuelState]) -> Result<(), String> {
    for s in states {
        let elo = if s.duels == 0 && (s.elo - START_ELO).abs() < 1e-9 { None } else { Some(s.elo) };
        write(c, s, elo)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::db;

    fn add(c: &Connection) -> i64 {
        c.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, thumb_object_id) \
             VALUES (lower(hex(randomblob(16))), NULL, 'image', 'x', 'jpg', 1, 'h', 0, 't')",
            [],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    #[test]
    fn weights_follow_the_rating() {
        assert_eq!(weight_for(1000.0), 1.0);
        assert_eq!(weight_for(1200.0), 2.0);
        assert_eq!(weight_for(800.0), 0.5);
        assert_eq!(weight_for(5000.0), 20.0);
        assert_eq!(weight_for(0.0), 0.25);
        assert_eq!(weight_for(1100.0), 1.41);
    }

    #[test]
    fn equal_players_move_by_half_k() {
        assert!((expected(1000.0, 1000.0) - 0.5).abs() < 1e-12);
        let (w, l) = rate(1000.0, 1000.0);
        assert!((w - 1016.0).abs() < 1e-9);
        assert!((l - 984.0).abs() < 1e-9);
        // An upset moves more than an expected win.
        let (w2, _) = rate(800.0, 1200.0);
        let (w3, _) = rate(1200.0, 800.0);
        assert!(w2 - 800.0 > w3 - 1200.0);
    }

    #[test]
    fn result_saves_and_restore_undoes() {
        let c = db::create_empty().unwrap();
        let a = add(&c);
        let b = add(&c);
        let o = result(&c, a, b).unwrap();
        assert!((o.winner_elo - 1016.0).abs() < 1e-9);
        assert_eq!(o.winner_weight, weight_for(1016.0));
        let now = ratings(&c, &[a, b, 9999]).unwrap();
        assert_eq!(now.len(), 2);
        assert_eq!(now[0].duels, 1);
        assert_eq!(now[1].weight, o.loser_weight);
        assert!(result(&c, a, a).is_err());
        assert!(result(&c, a, 9999).is_err());

        restore(&c, &o.before).unwrap();
        let back = ratings(&c, &[a, b]).unwrap();
        assert_eq!(back, o.before);
        let raw: Option<f64> = c.query_row("SELECT elo FROM media WHERE id = ?1", [a], |r| r.get(0)).unwrap();
        assert_eq!(raw, None);
    }
}
