require "test_helper"

class Console::IdentitiesControllerTest < ActionDispatch::IntegrationTest
  setup do
    @prev = ENV["CENTAUR_CONSOLE_LINK_ONLY_PROVIDERS"]
    ENV["CENTAUR_CONSOLE_LINK_ONLY_PROVIDERS"] = "slack"
    @member = users(:member_user)
    post login_url, params: { email: @member.email, password: "password123456" }
    assert_equal @member.id, session[:user_id]
  end

  teardown do
    if @prev.nil?
      ENV.delete("CENTAUR_CONSOLE_LINK_ONLY_PROVIDERS")
    else
      ENV["CENTAUR_CONSOLE_LINK_ONLY_PROVIDERS"] = @prev
    end
  end

  test "destroy removes a link-only identity from the current user" do
    identity = @member.user_identities.create!(
      provider: "slack", subject: "U-mine", email: "member@acme.example", email_verified: true
    )
    assert_difference -> { @member.user_identities.count }, -1 do
      delete console_identity_url(identity)
    end
    assert_redirected_to console_integrations_path
    assert_match(/disconnected/i, flash[:notice])
  end

  test "destroy refuses to remove the login identity" do
    identity = @member.user_identities.create!(
      provider: "google", subject: "g-mine", email: "member@acme.example", email_verified: true
    )
    assert_no_difference -> { @member.user_identities.count } do
      delete console_identity_url(identity)
    end
    assert_redirected_to console_integrations_path
    assert_match(/can't disconnect/i, flash[:alert])
  end

  test "destroy cannot touch another user's identity" do
    other = users(:acme_admin)
    identity = other.user_identities.create!(
      provider: "slack", subject: "U-other", email: "admin@acme.example", email_verified: true
    )
    delete console_identity_url(identity)
    assert_response :not_found
    assert UserIdentity.exists?(identity.id)
  end
end
