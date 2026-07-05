function getPayPalApiBase() {
  return process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

function normalizePayPalApiError(path, body) {
  const text = String(body || '');

  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  const name = String(payload?.name || '');
  const message = String(payload?.message || '');

  if (
    path.includes('/customer/partner-referrals') &&
    name === 'NOT_AUTHORIZED' &&
    message.includes('insufficient permissions')
  ) {
    const error = new Error(
      'PayPal seller onboarding is not enabled for the PayPal app currently configured on this platform. This flow requires a PayPal approved partner setup for Partner Referrals in the same environment. Verify that this is the correct sandbox/live business account and contact PayPal to enable Multiparty or Partner Referrals access if needed.'
    );
    error.statusCode = 403;
    return error;
  }

  const error = new Error(`PayPal API error: ${text}`);
  error.statusCode = payload?.name === 'NOT_AUTHORIZED' ? 403 : undefined;
  return error;
}

async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required.');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`${getPayPalApiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PayPal OAuth error: ${body}`);
  }

  const payload = await response.json();
  return payload.access_token;
}

async function paypalApiFetch(path, init = {}) {
  const accessToken = await getPayPalAccessToken();
  const response = await fetch(`${getPayPalApiBase()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers || {}),
    },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });

  if (!response.ok) {
    const body = await response.text();
    throw normalizePayPalApiError(path, body);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function getApprovalUrl(order) {
  const links = Array.isArray(order?.links) ? order.links : [];
  return (
    links.find((link) => link.rel === 'payer-action')?.href ||
    links.find((link) => link.rel === 'approve')?.href ||
    null
  );
}

function getOrderIdFromWebhookResource(resource = {}) {
  if (resource.supplementary_data?.related_ids?.order_id) {
    return resource.supplementary_data.related_ids.order_id;
  }

  if (Array.isArray(resource.links)) {
    const parentLink = resource.links.find((link) => link.rel === 'up');
    if (parentLink?.href) {
      return parentLink.href.split('/').pop() || null;
    }
  }

  return null;
}

function getCompletedCapture(order = {}) {
  const purchaseUnit = Array.isArray(order.purchase_units) ? order.purchase_units[0] : null;
  const captures = purchaseUnit?.payments?.captures;
  if (!Array.isArray(captures)) {
    return null;
  }

  return captures.find((capture) => capture.status === 'COMPLETED') || captures[0] || null;
}

async function verifyPayPalWebhook(headers, rawBody) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!webhookId) {
    throw new Error('PAYPAL_WEBHOOK_ID is required to verify PayPal webhooks.');
  }

  const result = await paypalApiFetch('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    json: {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: JSON.parse(rawBody),
    },
  });

  return result.verification_status === 'SUCCESS';
}

module.exports = {
  getCompletedCapture,
  getOrderIdFromWebhookResource,
  getPayPalApiBase,
  getPayPalAccessToken,
  getApprovalUrl,
  paypalApiFetch,
  verifyPayPalWebhook,
};
