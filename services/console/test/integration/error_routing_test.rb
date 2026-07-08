require "test_helper"

# Regression coverage for the two expected-4xx conditions that used to raise and
# get logged at error level: a non-GET request to the site root, and a
# tokenless/stale-CSRF form POST.
class ErrorRoutingTest < ActionDispatch::IntegrationTest
  test "POST to the site root returns a JSON 404 instead of raising RoutingError" do
    post "/"
    assert_response :not_found
    assert_equal({ "error" => { "message" => "not found" } }, response.parsed_body)
  end

  test "other verbs on the root also resolve to the JSON 404 fallback" do
    put "/"
    assert_response :not_found
  end

  test "unmatched non-root paths still return the JSON 404 fallback" do
    post "/definitely/not/a/route"
    assert_response :not_found
    assert_equal({ "error" => { "message" => "not found" } }, response.parsed_body)
  end

  test "GET on the root is still served by the console, not the 404 fallback" do
    get "/"
    # Not signed in, so require_login bounces to the login form. The point is
    # that the root is NOT swallowed by the unmatched-route 404 fallback.
    assert_redirected_to login_path
  end
end

class InvalidAuthenticityTokenTest < ActionDispatch::IntegrationTest
  setup do
    @original_forgery_protection = ActionController::Base.allow_forgery_protection
    ActionController::Base.allow_forgery_protection = true
  end

  teardown do
    ActionController::Base.allow_forgery_protection = @original_forgery_protection
  end

  test "a tokenless HTML form POST is rejected without raising, bounced to login" do
    post login_path, params: { email: "someone@example.com", password: "nope" }
    assert_redirected_to login_path
    assert_equal "Your session expired. Please sign in again.", flash[:alert]
  end

  test "a tokenless non-HTML POST is rejected with a 422" do
    post login_path, headers: { "Accept" => "application/json" }
    assert_response :unprocessable_entity
  end
end
