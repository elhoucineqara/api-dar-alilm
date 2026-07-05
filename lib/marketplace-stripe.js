const Stripe = require('stripe');

const { getFrontendUrl } = require('./course-payments');
const { getStripeConnectState } = require('./user-payment-settings');

function getStripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    const error = new Error('STRIPE_SECRET_KEY is required for Stripe Connect.');
    error.statusCode = 500;
    throw error;
  }

  return new Stripe(secretKey);
}

function getStripeConnectRefreshUrl(overrideUrl) {
  return overrideUrl || process.env.STRIPE_CONNECT_REFRESH_URL || `${getFrontendUrl()}/instructor/payments?stripe=refresh`;
}

function getStripeConnectReturnUrl(overrideUrl) {
  return overrideUrl || process.env.STRIPE_CONNECT_RETURN_URL || `${getFrontendUrl()}/instructor/payments?stripe=return`;
}

function isStripeMissingResource(error) {
  return error?.code === 'resource_missing' || error?.statusCode === 404;
}

function mapStripeConnectConfigurationError(error) {
  const message = String(error?.message || '');

  if (message.includes("signed up for Connect")) {
    const normalizedError = new Error(
      'Stripe Connect is not enabled on the Stripe account currently configured for this platform. Open https://dashboard.stripe.com/connect with that same Stripe account, finish the Connect setup, then try again.'
    );
    normalizedError.statusCode = 400;
    return normalizedError;
  }

  return error;
}

async function createStripeConnectedAccount(user) {
  const stripe = getStripeClient();
  const createPayload = {
    type: 'express',
    email: user.email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    metadata: {
      userId: user._id.toString(),
      role: user.role || 'instructor',
      source: 'daralilm-marketplace',
    },
  };

  if (process.env.STRIPE_CONNECT_DEFAULT_COUNTRY) {
    createPayload.country = process.env.STRIPE_CONNECT_DEFAULT_COUNTRY;
  }

  try {
    return await stripe.accounts.create(createPayload);
  } catch (error) {
    throw mapStripeConnectConfigurationError(error);
  }
}

async function ensureStripeConnectedAccount(user) {
  const stripe = getStripeClient();
  const stripeConnect = getStripeConnectState(user);

  if (stripeConnect.accountId) {
    try {
      return await stripe.accounts.retrieve(stripeConnect.accountId);
    } catch (error) {
      if (!isStripeMissingResource(error)) {
        throw error;
      }
    }
  }

  const account = await createStripeConnectedAccount(user);

  user.paymentSettings = user.paymentSettings || {};
  user.paymentSettings.stripeConnect = {
    ...(user.paymentSettings.stripeConnect || {}),
    accountId: account.id,
    connectedAt: user.paymentSettings.stripeConnect?.connectedAt || new Date(),
  };
  await user.save();

  return account;
}

async function syncStripeConnectedAccount(user) {
  const stripeConnect = getStripeConnectState(user);

  if (!stripeConnect.accountId) {
    return null;
  }

  const stripe = getStripeClient();
  let account;

  try {
    account = await stripe.accounts.retrieve(stripeConnect.accountId);
  } catch (error) {
    if (!isStripeMissingResource(error)) {
      throw error;
    }

    user.paymentSettings = user.paymentSettings || {};
    user.paymentSettings.stripeConnect = {
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      onboardingComplete: false,
    };
    await user.save();
    return null;
  }

  user.paymentSettings = user.paymentSettings || {};
  user.paymentSettings.stripeConnect = {
    ...(user.paymentSettings.stripeConnect || {}),
    accountId: account.id,
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
    onboardingComplete: Boolean(
      account.details_submitted && account.charges_enabled && account.payouts_enabled
    ),
    connectedAt: user.paymentSettings.stripeConnect?.connectedAt || new Date(),
    lastSyncedAt: new Date(),
  };

  await user.save();
  return user.paymentSettings.stripeConnect;
}

async function createStripeOnboardingLink(user, options = {}) {
  try {
    const stripe = getStripeClient();
    const account = await ensureStripeConnectedAccount(user);
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: getStripeConnectRefreshUrl(options.refreshUrl),
      return_url: getStripeConnectReturnUrl(options.returnUrl),
      type: 'account_onboarding',
      collection_options: {
        fields: 'eventually_due',
      },
    });

    return {
      accountId: account.id,
      url: accountLink.url,
      expiresAt: accountLink.expires_at || null,
    };
  } catch (error) {
    throw mapStripeConnectConfigurationError(error);
  }
}

module.exports = {
  createStripeOnboardingLink,
  getStripeClient,
  syncStripeConnectedAccount,
};
