require_relative "console_env"

# Cookie-session lifetime configuration for the console login session.
#
# The console signs an operator in by storing their user id in a Rails
# cookie-store session (see ApplicationController#sign_in_console_user). With no
# configured expiry Rails emits a *browser-session* cookie, which many browsers
# drop as soon as the window closes -- operators then get signed out far sooner
# than they expect.
#
# CENTAUR_CONSOLE_SESSION_MAX_AGE makes the cookie lifetime configurable.
# Because Rails' cookie_store re-emits the session cookie on every authenticated
# response, this is an *idle* (sliding) lifetime: the expiry clock resets on each
# visit, so an operator is signed out only after this much inactivity.
#   - unset            -> DEFAULT_MAX_AGE_SECONDS (a persistent cookie)
#   - a positive integer number of seconds (base 10) -> that lifetime
#   - "0" or "session" -> a browser-session cookie (no Max-Age/Expires)
#   - anything else     -> DEFAULT_MAX_AGE_SECONDS (invalid values never shorten
#                          the session unexpectedly)
#
# The value is read once at boot; changing it takes effect on process restart.
#
# Kept as a plain module (no Rails dependency) so config/initializers can require
# it directly, matching ConsoleEnv.
module ConsoleSession
  # Persistent-by-default lifetime when CENTAUR_CONSOLE_SESSION_MAX_AGE is unset:
  # two weeks, expressed in seconds.
  DEFAULT_MAX_AGE_SECONDS = 14 * 24 * 60 * 60

  module_function

  # The value for config.session_store's :expire_after option: an integer number
  # of seconds, or nil for a browser-session cookie (Rails treats nil as "no
  # expiry attribute"). Parsed base 10 so a leading zero is not read as octal.
  def expire_after
    raw = ConsoleEnv["SESSION_MAX_AGE"].to_s.strip
    return DEFAULT_MAX_AGE_SECONDS if raw.empty?
    return nil if raw == "0" || raw.casecmp?("session")

    seconds = Integer(raw, 10, exception: false)
    seconds&.positive? ? seconds : DEFAULT_MAX_AGE_SECONDS
  end
end
