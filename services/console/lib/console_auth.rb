# Configuration for console SSO login. Unlike OauthApp (a DB-managed integration
# the broker mints credentials for), the login client is infrastructure: its
# client_id/client_secret and the bootstrap-admin allowlist come from the
# environment (or Rails credentials as a fallback), not a table.
#
# Per provider, looks up:
#   CENTAUR_CONSOLE_<PROVIDER>_CLIENT_ID / _CLIENT_SECRET (ENV)
#   credentials.console_auth.<provider>.client_id/secret  (fallback)
# A provider is offered on the login page only when both are present.
#
# Bootstrap admins are matched by email and become active + admin on first login
# (the first admin needs no existing approver):
#   CENTAUR_CONSOLE_BOOTSTRAP_ADMINS="me@acme.com, you@acme.com"   (ENV)
#   credentials.console_auth.bootstrap_admins                   (fallback: string or array)
module ConsoleAuth
  # The providers a Login::Providers strategy exists for. A provider must also be
  # `configured?` to actually appear on the login page.
  SUPPORTED = %w[google slack].freeze

  module_function

  # Configured + supported provider keys.
  def providers
    SUPPORTED.select { |p| configured?(p) }
  end

  # Providers offered on the login page: every configured provider that is not
  # marked link-only. Login-capable providers can authenticate AND provision a
  # user; link-only providers cannot log anyone in (see #link_only_providers).
  def login_providers
    providers.reject { |p| link_only?(p) }
  end

  # Configured providers that may only be linked to an already-authenticated
  # account (never used to log in or provision). These are what the console
  # offers as "Connect" buttons on the Integrations page.
  def linkable_providers
    providers.select { |p| link_only?(p) }
  end

  # Whether a configured provider is link-only. Controlled by
  #   CENTAUR_CONSOLE_LINK_ONLY_PROVIDERS="slack"   (comma/space list, ENV)
  #   credentials.console_auth.link_only_providers   (fallback: string or array)
  # Empty by default, so a deployment that configures a provider keeps today's
  # behavior (it logs in) unless it opts that provider into link-only.
  def link_only?(provider)
    link_only_providers.include?(provider.to_s.strip.downcase)
  end

  def link_only_providers
    raw = ConsoleEnv["LINK_ONLY_PROVIDERS"].presence || credentials_dig(:link_only_providers)
    list = raw.is_a?(Array) ? raw : raw.to_s.split(/[,\s]+/)
    list.map { |p| p.to_s.strip.downcase }.reject(&:empty?).select { |p| SUPPORTED.include?(p) }.uniq
  end

  def configured?(provider)
    SUPPORTED.include?(provider.to_s) && client_id(provider).present? && client_secret(provider).present?
  end

  def client_id(provider) = setting(provider, "client_id")
  def client_secret(provider) = setting(provider, "client_secret")

  def bootstrap_admin?(email)
    normalized = email.to_s.strip.downcase
    return false if normalized.empty?
    bootstrap_admins.include?(normalized)
  end

  def bootstrap_admins
    raw = ConsoleEnv["BOOTSTRAP_ADMINS"].presence || credentials_dig(:bootstrap_admins)
    list = raw.is_a?(Array) ? raw : raw.to_s.split(/[,\s]+/)
    list.map { |e| e.to_s.strip.downcase }.reject(&:empty?).uniq
  end

  # ENV first (CENTAUR_CONSOLE_GOOGLE_CLIENT_ID), then credentials
  # (console_auth.google.client_id).
  def setting(provider, field)
    env = ConsoleEnv["#{provider.to_s.upcase}_#{field.upcase}"].presence
    return env if env
    credentials_dig(provider.to_sym, field.to_sym)
  end

  def credentials_dig(*path)
    Rails.application.credentials.dig(:console_auth, *path)
  end
end
