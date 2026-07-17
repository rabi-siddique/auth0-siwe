package app.ymax.keycloak;

import java.util.List;
import org.keycloak.Config;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.AuthenticatorFactory;
import org.keycloak.models.AuthenticationExecutionModel.Requirement;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.provider.ProviderConfigProperty;

/**
 * Factory for {@link ConsentRedirectAuthenticator}.
 *
 * The shared HS256 secret is read from a server SPI option (NOT a per-execution config property,
 * which is readable in the admin console):
 *
 *   --spi-authenticator-ymax-consent-redirect-secret=&lt;secret&gt;
 *   or env: KC_SPI_AUTHENTICATOR_YMAX_CONSENT_REDIRECT_SECRET=&lt;secret&gt;
 *
 * The (non-secret) consent-page URL is a per-execution config property so it can be set/overridden
 * in the flow (and shipped in the realm export).
 */
public class ConsentRedirectAuthenticatorFactory implements AuthenticatorFactory {

  public static final String PROVIDER_ID = "ymax-consent-redirect";
  public static final String CONFIG_CONSENT_URL = "consentUrl";

  private static final Requirement[] REQUIREMENT_CHOICES = {
    Requirement.REQUIRED, Requirement.DISABLED
  };

  private String secret;

  @Override
  public void init(Config.Scope config) {
    this.secret = config.get("secret");
  }

  @Override
  public Authenticator create(KeycloakSession session) {
    return new ConsentRedirectAuthenticator(secret);
  }

  @Override
  public String getId() {
    return PROVIDER_ID;
  }

  @Override
  public String getDisplayType() {
    return "Ymax Consent Redirect";
  }

  @Override
  public String getReferenceCategory() {
    return "ymax";
  }

  @Override
  public boolean isConfigurable() {
    return true;
  }

  @Override
  public Requirement[] getRequirementChoices() {
    return REQUIREMENT_CHOICES;
  }

  @Override
  public boolean isUserSetupAllowed() {
    return false;
  }

  @Override
  public String getHelpText() {
    return "Redirects to the external MCP consent page to select portfolio capabilities, then writes"
        + " the chosen scopes and agent wallet as user attributes.";
  }

  @Override
  public List<ProviderConfigProperty> getConfigProperties() {
    ProviderConfigProperty consentUrl = new ProviderConfigProperty();
    consentUrl.setName(CONFIG_CONSENT_URL);
    consentUrl.setLabel("Consent page URL");
    consentUrl.setType(ProviderConfigProperty.STRING_TYPE);
    consentUrl.setHelpText("Public URL of the MCP server's /consent page, e.g. https://<host>/consent");
    return List.of(consentUrl);
  }

  @Override
  public void postInit(KeycloakSessionFactory factory) {}

  @Override
  public void close() {}
}
