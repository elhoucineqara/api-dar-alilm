const { nanoid } = require('nanoid');

const { getFrontendUrl } = require('./course-payments');
const { paypalApiFetch } = require('./paypal');

function getBackendUrl() {
  return (
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    `http://localhost:${process.env.PORT || 5000}`
  ).replace(/\/+$/, '');
}

function getPayPalPartnerAttributionId() {
  const partnerAttributionId = process.env.PAYPAL_PARTNER_ATTRIBUTION_ID;

  if (!partnerAttributionId) {
    const error = new Error(
      'PAYPAL_PARTNER_ATTRIBUTION_ID is required for PayPal marketplace onboarding.'
    );
    error.statusCode = 500;
    throw error;
  }

  return partnerAttributionId;
}

function createPayPalAuthAssertion({ sellerMerchantId }) {
  const clientId = process.env.PAYPAL_CLIENT_ID;

  if (!clientId || !sellerMerchantId) {
    return null;
  }

  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: clientId,
      payer_id: sellerMerchantId,
    })
  ).toString('base64url');

  return `${header}.${payload}.`;
}

function getPayPalPartnerHeaders({ sellerMerchantId } = {}) {
  const headers = {
    'PayPal-Partner-Attribution-Id': getPayPalPartnerAttributionId(),
  };

  const authAssertion = createPayPalAuthAssertion({ sellerMerchantId });
  if (authAssertion) {
    headers['PayPal-Auth-Assertion'] = authAssertion;
  }

  return headers;
}

function getPayPalReturnUrl() {
  return (
    process.env.PAYPAL_PARTNER_RETURN_URL ||
    `${getBackendUrl()}/api/instructor/payment-settings/paypal/return`
  );
}

function normalizeFrontendReturnPath(path) {
  if (typeof path === 'string' && path.trim().startsWith('/')) {
    return path.trim();
  }

  return '/instructor/payments';
}

function getPayPalReturnRedirectUrl(status, message, options = {}) {
  const frontendReturnPath = normalizeFrontendReturnPath(options.frontendReturnPath);
  const url = new URL(`${getFrontendUrl()}${frontendReturnPath}`);
  url.searchParams.set('paypal', status);
  if (message) {
    url.searchParams.set('message', message);
  }
  return url.toString();
}

function getPayPalActionUrl(referralResponse = {}) {
  const links = Array.isArray(referralResponse.links) ? referralResponse.links : [];
  return links.find((link) => link.rel === 'action_url')?.href || null;
}

async function createPayPalOnboardingLink(user, options = {}) {
  const trackingId = `paypal_${nanoid(24)}`;
  const frontendReturnPath = normalizeFrontendReturnPath(options.frontendReturnPath);

  user.paymentSettings = user.paymentSettings || {};
  user.paymentSettings.paypalMerchant = {
    ...(user.paymentSettings.paypalMerchant || {}),
    frontendReturnPath,
    trackingId,
    onboardingStatus: 'pending',
    lastSyncedAt: new Date(),
  };
  await user.save();

  const referral = await paypalApiFetch('/v2/customer/partner-referrals', {
    method: 'POST',
    headers: getPayPalPartnerHeaders(),
    json: {
      tracking_id: trackingId,
      operations: [
        {
          operation: 'API_INTEGRATION',
          api_integration_preference: {
            rest_api_integration: {
              integration_method: 'PAYPAL',
              integration_type: 'THIRD_PARTY',
              third_party_details: {
                features: ['PAYMENT', 'REFUND', 'PARTNER_FEE'],
              },
            },
          },
        },
      ],
      products: ['PPCP'],
      legal_consents: [
        {
          type: 'SHARE_DATA_CONSENT',
          granted: true,
        },
      ],
      partner_config_override: {
        return_url: getPayPalReturnUrl(),
        return_url_description: 'Return to Dar Al-Ilm',
      },
    },
  });

  const actionUrl = getPayPalActionUrl(referral);
  if (!actionUrl) {
    const error = new Error('PayPal did not return an onboarding link.');
    error.statusCode = 500;
    throw error;
  }

  return {
    trackingId,
    actionUrl,
  };
}

module.exports = {
  createPayPalOnboardingLink,
  getPayPalPartnerHeaders,
  getPayPalReturnRedirectUrl,
};
