package app.ymax.keycloak;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.core.UriBuilder;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.Authenticator;
import org.keycloak.common.util.Time;
import org.keycloak.models.AuthenticatorConfigModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.utils.KeycloakModelUtils;
import org.keycloak.sessions.AuthenticationSessionModel;

/**
 * Consent-redirect authenticator.
 *
 * Runs at the end of the browser flow, after the siwe-oidc identity provider has established the
 * user (the Ethereum wallet). It suspends login, redirects the browser to the MCP server's external
 * /consent page to pick portfolio capabilities, then resumes: it verifies the page's signed reply
 * and writes the chosen scopes + agent wallet as user attributes, which User Attribute protocol
 * mappers project into the issued access token.
 *
 * This is the Keycloak counterpart of the old Auth0 "Redirect Action". The page-side logic lives in
 * this repo's src/consent.ts; the two share a symmetric HS256 secret (>= 32 bytes; Nimbus rejects
 * shorter HS256 keys).
 */
public class ConsentRedirectAuthenticator implements Authenticator {

  static final String SCOPES_ATTR = "ymax_scopes";
  static final String AGENT_ATTR = "ymax_agent";
  // Set by the siwe-oidc IdP's attribute importer (incoming `sub` → this attribute). Keycloak's own
  // username is generated, so we read the wallet from here.
  private static final String WALLET_ATTR = "wallet_address";
  private static final String STATE_NOTE = "ymax-consent-state";
  private static final long TOKEN_TTL_SECONDS = 300;

  private final String secret;

  ConsentRedirectAuthenticator(String secret) {
    this.secret = secret;
  }

  @Override
  public void authenticate(AuthenticationFlowContext context) {
    String consentUrl = configValue(context, ConsentRedirectAuthenticatorFactory.CONFIG_CONSENT_URL);
    if (secret == null || secret.isBlank() || consentUrl == null || consentUrl.isBlank()) {
      context.failure(AuthenticationFlowError.INTERNAL_ERROR);
      return;
    }

    UserModel user = context.getUser();
    String wallet = user.getFirstAttribute(WALLET_ATTR);
    String sub = (wallet != null && !wallet.isBlank()) ? wallet : user.getUsername();

    // A single-use nonce, stored on the auth session and echoed in the signed token, so the reply
    // can only be replayed into the login it belongs to.
    String state = KeycloakModelUtils.generateId();
    AuthenticationSessionModel authSession = context.getAuthenticationSession();
    authSession.setAuthNote(STATE_NOTE, state);

    // The login-actions URL that re-enters this execution's action() when the page redirects back.
    // Requires the browser to keep its Keycloak auth-session cookie across the /consent hop, which
    // holds for a same-browser top-level redirect.
    String accessCode = context.generateAccessCode();
    URI returnUri = context.getActionUrl(accessCode);

    String sessionToken;
    try {
      sessionToken =
          sign(new JWTClaimsSet.Builder().subject(sub).claim("state", state)).serialize();
    } catch (Exception e) {
      context.failure(AuthenticationFlowError.INTERNAL_ERROR);
      return;
    }

    URI redirect =
        UriBuilder.fromUri(consentUrl)
            .queryParam("session_token", sessionToken)
            .queryParam("state", state)
            .queryParam("redirect_uri", returnUri.toString())
            .build();
    context.challenge(
        Response.status(Response.Status.FOUND).header("Location", redirect.toString()).build());
  }

  @Override
  public void action(AuthenticationFlowContext context) {
    String token =
        context.getHttpRequest().getUri().getQueryParameters().getFirst("session_token");
    if (token == null || token.isBlank()) {
      context.failure(AuthenticationFlowError.INVALID_CREDENTIALS);
      return;
    }

    JWTClaimsSet claims;
    try {
      SignedJWT jwt = SignedJWT.parse(token);
      if (!jwt.verify(new MACVerifier(secret.getBytes(StandardCharsets.UTF_8)))) {
        context.failure(AuthenticationFlowError.INVALID_CREDENTIALS);
        return;
      }
      claims = jwt.getJWTClaimsSet();
    } catch (Exception e) {
      context.failure(AuthenticationFlowError.INVALID_CREDENTIALS);
      return;
    }

    Date exp = claims.getExpirationTime();
    if (exp == null || exp.before(new Date(Time.currentTimeMillis()))) {
      context.failure(AuthenticationFlowError.EXPIRED_CODE);
      return;
    }

    // Bind the reply to this login: its `state` must match the nonce we stored on the auth session.
    String expectedState = context.getAuthenticationSession().getAuthNote(STATE_NOTE);
    String actualState;
    try {
      actualState = claims.getStringClaim("state");
    } catch (Exception e) {
      actualState = null;
    }
    if (expectedState == null || !expectedState.equals(actualState)) {
      context.failure(AuthenticationFlowError.INVALID_CREDENTIALS);
      return;
    }

    List<String> scopes;
    String agent;
    try {
      scopes = claims.getStringListClaim("scopes");
      agent = claims.getStringClaim("agent");
    } catch (Exception e) {
      context.failure(AuthenticationFlowError.INVALID_CREDENTIALS);
      return;
    }

    // Persist the consent selection as user attributes; the realm's User Attribute mappers project
    // these into the access token as https://ymax.app/scopes and https://ymax.app/agent.
    UserModel user = context.getUser();
    user.setAttribute(SCOPES_ATTR, scopes != null ? scopes : Collections.emptyList());
    if (agent != null && !agent.isBlank()) {
      user.setSingleAttribute(AGENT_ATTR, agent);
    } else {
      user.removeAttribute(AGENT_ATTR);
    }

    context.success();
  }

  private SignedJWT sign(JWTClaimsSet.Builder builder) throws Exception {
    long now = Time.currentTimeMillis();
    JWTClaimsSet claims =
        builder
            .issueTime(new Date(now))
            .expirationTime(new Date(now + TOKEN_TTL_SECONDS * 1000))
            .build();
    SignedJWT jwt =
        new SignedJWT(
            new JWSHeader.Builder(JWSAlgorithm.HS256).type(JOSEObjectType.JWT).build(), claims);
    jwt.sign(new MACSigner(secret.getBytes(StandardCharsets.UTF_8)));
    return jwt;
  }

  private static String configValue(AuthenticationFlowContext context, String key) {
    AuthenticatorConfigModel cfg = context.getAuthenticatorConfig();
    return cfg == null ? null : cfg.getConfig().get(key);
  }

  @Override
  public boolean requiresUser() {
    return true; // guarantees context.getUser() is non-null (runs after brokered login)
  }

  @Override
  public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) {
    return true;
  }

  @Override
  public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) {}

  @Override
  public void close() {}
}
