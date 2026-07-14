# Lets a signed-in operator remove a linked SSO identity from their own account
# (the "Disconnect" action on the Integrations page). Only link-only identities
# (e.g. Slack) can be removed here -- the login identity that authenticates the
# account is protected so a user can't lock themselves out. Not admin-gated: a
# user manages only their own identities (scoped through current_user).
class Console::IdentitiesController < ApplicationController
  layout "console"

  def destroy
    identity = current_user.user_identities.find_by_oid!(params[:id])
    if ConsoleAuth.link_only?(identity.provider)
      identity.destroy!
      redirect_to console_integrations_path,
                  notice: "Disconnected your #{identity.provider.capitalize} account."
    else
      redirect_to console_integrations_path,
                  alert: "You can't disconnect the account you sign in with."
    end
  end
end
