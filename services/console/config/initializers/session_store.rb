require_relative "../../lib/console_session"

# Configure the console login cookie session. The key preserves the historical
# default Rails derived from the application module name (IronControl ->
# "_iron_control_session"), so tuning the lifetime never invalidates operators'
# existing sessions. The lifetime is operator-configurable via
# CENTAUR_CONSOLE_SESSION_MAX_AGE; see ConsoleSession.
Rails.application.config.session_store :cookie_store,
  key: "_iron_control_session",
  expire_after: ConsoleSession.expire_after
