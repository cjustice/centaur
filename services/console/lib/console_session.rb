require_relative "console_env"

# Cookie-session lifetime configuration for the console login session.
#
# The console signs an operator in by storing their user id in a Rails
# cookie-store session (see ApplicationController#sign_in_console_user). With no
# configured expiry Rails emits a *browser-session* cookie, which many browsers
# drop as soon as the window closes -- operators then get signed out far sooner
# than they expect.
#
# CENTAUR_CONSOLE_SESSION_MAX_AGE makes the absolute lifetime configurable:
#   - unset            -> DEFAULT_MAX_AGE_SECONDS (a persistent cookie)
#   - a positive integer number of seconds -> that lifetime
#   - "0" or "session" -> a browser-session cookie (no Max-Age/Expires)
#   - anything else     -> DEFAULT_MAX_AGE_SECONDS (invalid values never shorten
#                          the session unexpectedly)
#
# Kept as a plain module (no Rails dependency) so config/initializers can require
# it directly, matching ConsoleEnv.
module ConsoleSession
  # Persistent-by-default lifetime when CENTAUR_CONSOLE_SESSION_MAX_AGE is unset:
  # two weeks, expressed in seconds.
  DEFAULT_MAX_AGE_SECONDS = 14 * 24 * 60 * 60

  module_function

  # The value for config.session_store's :expire_after option: an integer number
  # of seconds, or nil for a browser-session cookie. nil is what Rails treats as
  # "no absolute expiry".
  def expire_after
    raw = ConsoleEnv["SESSION_MAX_AGE"].to_s.strip
    return DEFAULT_MAX_AGE_SECONDS if raw.empty?
    return nil if raw == "0" || raw.casecmp?("session")

    seconds = Integer(raw, exception: false)
    seconds&.positive? ? seconds : DEFAULT_MAX_AGE_SECONDS
  end
end
