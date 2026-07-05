function getPaymentSettings(user = {}) {
  return user?.paymentSettings || {};
}

function getStripeConnectState(user = {}) {
  const stripeConnect = getPaymentSettings(user).stripeConnect || {};

  return {
    accountId: stripeConnect.accountId || null,
    chargesEnabled: Boolean(stripeConnect.chargesEnabled),
    payoutsEnabled: Boolean(stripeConnect.payoutsEnabled),
    detailsSubmitted: Boolean(stripeConnect.detailsSubmitted),
    onboardingComplete: Boolean(stripeConnect.onboardingComplete),
    connectedAt: stripeConnect.connectedAt || null,
    lastSyncedAt: stripeConnect.lastSyncedAt || null,
  };
}

function getPayPalMerchantState(user = {}) {
  const paypalMerchant = getPaymentSettings(user).paypalMerchant || {};
  const isAdminPayPalRevenueReady = Boolean(user?.role === 'admin' && isPayPalRevenueConfigured());

  return {
    trackingId: paypalMerchant.trackingId || null,
    merchantId: paypalMerchant.merchantId || null,
    merchantEmail: paypalMerchant.merchantEmail || null,
    accountStatus: paypalMerchant.accountStatus || null,
    onboardingStatus:
      paypalMerchant.onboardingStatus || (isAdminPayPalRevenueReady ? 'configured' : 'not_started'),
    permissionsGranted: isAdminPayPalRevenueReady || Boolean(paypalMerchant.permissionsGranted),
    paymentsReceivable: isAdminPayPalRevenueReady || Boolean(paypalMerchant.paymentsReceivable),
    primaryEmailConfirmed:
      isAdminPayPalRevenueReady || Boolean(paypalMerchant.primaryEmailConfirmed),
    products: Array.isArray(paypalMerchant.products) ? paypalMerchant.products : [],
    connectedAt: paypalMerchant.connectedAt || null,
    lastSyncedAt: paypalMerchant.lastSyncedAt || null,
  };
}

function isPayPalRevenueConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

function isPayPalMarketplaceConfigured() {
  return Boolean(
    process.env.PAYPAL_CLIENT_ID &&
      process.env.PAYPAL_CLIENT_SECRET &&
      process.env.PAYPAL_PARTNER_ATTRIBUTION_ID
  );
}

function isStripeConnectReady(user = {}) {
  const stripeConnect = getStripeConnectState(user);
  return Boolean(
    stripeConnect.accountId &&
      stripeConnect.onboardingComplete &&
      stripeConnect.chargesEnabled &&
      stripeConnect.payoutsEnabled
  );
}

function isPayPalMerchantReady(user = {}) {
  if (!isPayPalRevenueConfigured()) {
    return false;
  }

  return user?.role === 'admin';
}

function getInstructorPaymentProviderAvailability(user = {}) {
  return {
    stripe: isStripeConnectReady(user),
    paypal: user?.role === 'admin' && isPayPalRevenueConfigured(),
  };
}

function hasInstructorPaymentProvider(user = {}) {
  const providers = getInstructorPaymentProviderAvailability(user);
  return providers.stripe || providers.paypal;
}

function serializeUserPaymentSettings(user = {}) {
  const paymentSettings = getPaymentSettings(user);

  return {
    preferredProvider: paymentSettings.preferredProvider || null,
    stripeCustomerId: paymentSettings.stripeCustomerId || null,
    paypalCustomerId: paymentSettings.paypalCustomerId || null,
    paypalMarketplaceConfigured: isPayPalMarketplaceConfigured(),
    paypalRevenueConfigured: isPayPalRevenueConfigured(),
    stripeConnect: getStripeConnectState(user),
    paypalMerchant: getPayPalMerchantState(user),
    availableInstructorProviders: getInstructorPaymentProviderAvailability(user),
  };
}

module.exports = {
  getInstructorPaymentProviderAvailability,
  getPayPalMerchantState,
  getPaymentSettings,
  getStripeConnectState,
  hasInstructorPaymentProvider,
  isPayPalRevenueConfigured,
  isPayPalMarketplaceConfigured,
  isPayPalMerchantReady,
  isStripeConnectReady,
  serializeUserPaymentSettings,
};
