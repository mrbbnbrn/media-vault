//! Small helpers shared by many modules.

/// Numbers for an SQL list: "1, 2, 3" (only numbers go into the SQL text).
pub fn id_list(ids: &[i64]) -> String {
    ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_of_numbers() {
        assert_eq!(id_list(&[]), "");
        assert_eq!(id_list(&[3, -1, 20]), "3, -1, 20");
    }
}
