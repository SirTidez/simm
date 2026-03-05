pub const APP_NAME: &str = "SIMM";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn user_agent() -> String {
    format!("{}/{}", APP_NAME, APP_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_agent_includes_app_name_and_package_version() {
        let ua = user_agent();
        assert_eq!(ua, format!("{}/{}", APP_NAME, env!("CARGO_PKG_VERSION")));
    }
}
