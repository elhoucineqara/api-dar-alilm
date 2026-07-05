const { serializePlatformSettings } = require('./platform-settings');
const {
  isPayPalRevenueConfigured,
  isPayPalMerchantReady,
  isStripeConnectReady,
} = require('./user-payment-settings');

function isStripeMarketplaceConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

function normalizeSettings(settings) {
  return settings?.allowStudentRegistrations !== undefined
    ? settings
    : serializePlatformSettings(settings);
}

function getInstructorModeStatus(adminUser = {}, settings = {}) {
  const normalizedSettings = normalizeSettings(settings);
  const platformProviders = {
    stripe: isStripeMarketplaceConfigured(),
    paypal: isPayPalRevenueConfigured(),
  };
  const adminPayoutProviders = {
    stripe: isStripeConnectReady(adminUser),
    paypal: isPayPalMerchantReady(adminUser),
  };
  const readyProviders = {
    stripe: platformProviders.stripe && adminPayoutProviders.stripe,
    paypal: platformProviders.paypal && adminPayoutProviders.paypal,
  };
  const fullyEnabled = Boolean(
    normalizedSettings.allowInstructorRegistrations &&
      normalizedSettings.allowInstructorCreatorAccess &&
      normalizedSettings.allowInstructorPublicSales
  );
  const partiallyEnabled = Boolean(
    !fullyEnabled &&
      (normalizedSettings.allowInstructorRegistrations ||
        normalizedSettings.allowInstructorCreatorAccess ||
        normalizedSettings.allowInstructorPublicSales)
  );
  const canEnable = readyProviders.stripe;
  const blockers = [];

  if (!platformProviders.stripe) {
    blockers.push(
      'Configure Stripe on the platform first. Instructors use Stripe to receive course revenue.'
    );
  }

  if (!adminPayoutProviders.stripe) {
    blockers.push(
      'Connect the admin Stripe payout account first. PayPal stays available only for admin-owned revenue.'
    );
  }

  return {
    fullyEnabled,
    partiallyEnabled,
    canEnable,
    platformProviders,
    adminPayoutProviders,
    readyProviders,
    blockers,
  };
}

module.exports = {
  getInstructorModeStatus,
  isStripeMarketplaceConfigured,
};
