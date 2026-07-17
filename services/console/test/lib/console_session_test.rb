require "test_helper"

class ConsoleSessionTest < ActiveSupport::TestCase
  KEYS = %w[CENTAUR_CONSOLE_SESSION_MAX_AGE IRON_CONTROL_SESSION_MAX_AGE].freeze

  setup do
    @prev_env = ENV.to_hash.slice(*KEYS)
    KEYS.each { |k| ENV.delete(k) }
  end

  teardown do
    KEYS.each { |k| ENV.delete(k) }
    @prev_env.each { |k, v| ENV[k] = v }
  end

  test "defaults to two weeks when unset" do
    assert_equal ConsoleSession::DEFAULT_MAX_AGE_SECONDS, ConsoleSession.expire_after
    assert_equal 14 * 24 * 60 * 60, ConsoleSession.expire_after
  end

  test "reads a positive integer number of seconds" do
    ENV["CENTAUR_CONSOLE_SESSION_MAX_AGE"] = "3600"
    assert_equal 3600, ConsoleSession.expire_after
  end

  test "honors the legacy IRON_CONTROL_ variable" do
    ENV["IRON_CONTROL_SESSION_MAX_AGE"] = "7200"
    assert_equal 7200, ConsoleSession.expire_after
  end

  test "0 means a browser-session cookie (no absolute expiry)" do
    ENV["CENTAUR_CONSOLE_SESSION_MAX_AGE"] = "0"
    assert_nil ConsoleSession.expire_after
  end

  test "\"session\" means a browser-session cookie, case-insensitively" do
    ENV["CENTAUR_CONSOLE_SESSION_MAX_AGE"] = "Session"
    assert_nil ConsoleSession.expire_after
  end

  test "ignores surrounding whitespace" do
    ENV["CENTAUR_CONSOLE_SESSION_MAX_AGE"] = "  3600  "
    assert_equal 3600, ConsoleSession.expire_after
  end

  test "falls back to the default for non-integer values" do
    ENV["CENTAUR_CONSOLE_SESSION_MAX_AGE"] = "not-a-number"
    assert_equal ConsoleSession::DEFAULT_MAX_AGE_SECONDS, ConsoleSession.expire_after
  end

  test "falls back to the default for negative values" do
    ENV["CENTAUR_CONSOLE_SESSION_MAX_AGE"] = "-100"
    assert_equal ConsoleSession::DEFAULT_MAX_AGE_SECONDS, ConsoleSession.expire_after
  end

  test "falls back to the default for a blank value" do
    ENV["CENTAUR_CONSOLE_SESSION_MAX_AGE"] = "   "
    assert_equal ConsoleSession::DEFAULT_MAX_AGE_SECONDS, ConsoleSession.expire_after
  end
end
