const PlatformSettings = require('../models/PlatformSettings');

function normalizePlatformFeePercent(value, fallback = 20) {
  const parsed = Number(value);
  const normalizedFallback = Number(Number(fallback || 20).toFixed(2));

  if (!Number.isFinite(parsed)) {
    return normalizedFallback;
  }

  if (parsed < 0) {
    return 0;
  }

  if (parsed > 100) {
    return 100;
  }

  return Number(parsed.toFixed(2));
}

function getDefaultPlatformFeePercent() {
  return normalizePlatformFeePercent(process.env.DEFAULT_PLATFORM_FEE_PERCENT, 20);
}

function normalizeBooleanSetting(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return Boolean(fallback);
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return Boolean(value);
}

function normalizeTrimmedString(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim();
  return normalized || fallback;
}

function getDefaultPlatformName() {
  return normalizeTrimmedString(process.env.PLATFORM_NAME, 'QaraNetwork');
}

function getDefaultSupportEmail() {
  return normalizeTrimmedString(process.env.PLATFORM_SUPPORT_EMAIL, 'mohamedqara@gmail.com').toLowerCase();
}

function getDefaultAllowStudentRegistrations() {
  return normalizeBooleanSetting(process.env.ALLOW_STUDENT_REGISTRATIONS, true);
}

function getDefaultAllowInstructorRegistrations() {
  return normalizeBooleanSetting(process.env.ALLOW_INSTRUCTOR_REGISTRATIONS, false);
}

function getDefaultAllowInstructorCreatorAccess() {
  return normalizeBooleanSetting(process.env.ALLOW_INSTRUCTOR_CREATOR_ACCESS, false);
}

function getDefaultAllowInstructorPublicSales() {
  return normalizeBooleanSetting(process.env.ALLOW_INSTRUCTOR_PUBLIC_SALES, false);
}

function getDefaultMaintenanceMode() {
  return normalizeBooleanSetting(process.env.PLATFORM_MAINTENANCE_MODE, false);
}

async function getPlatformSettings() {
  return PlatformSettings.findOneAndUpdate(
    { key: 'default' },
    {
      $setOnInsert: {
        key: 'default',
        payment: {
          platformFeePercent: getDefaultPlatformFeePercent(),
        },
        general: {
          platformName: getDefaultPlatformName(),
          supportEmail: getDefaultSupportEmail(),
        },
        access: {
          allowStudentRegistrations: getDefaultAllowStudentRegistrations(),
          allowInstructorRegistrations: getDefaultAllowInstructorRegistrations(),
          allowInstructorCreatorAccess: getDefaultAllowInstructorCreatorAccess(),
          allowInstructorPublicSales: getDefaultAllowInstructorPublicSales(),
          maintenanceMode: getDefaultMaintenanceMode(),
        },
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );
}

async function getPlatformFeePercent() {
  const settings = await getPlatformSettings();
  return normalizePlatformFeePercent(
    settings?.payment?.platformFeePercent,
    getDefaultPlatformFeePercent()
  );
}

async function updatePlatformPaymentSettings({ platformFeePercent }) {
  const normalizedPercent = normalizePlatformFeePercent(
    platformFeePercent,
    getDefaultPlatformFeePercent()
  );

  return PlatformSettings.findOneAndUpdate(
    { key: 'default' },
    {
      $set: {
        key: 'default',
        'payment.platformFeePercent': normalizedPercent,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );
}

async function updatePlatformSettings({
  platformFeePercent,
  platformName,
  supportEmail,
  allowStudentRegistrations,
  allowInstructorRegistrations,
  allowInstructorCreatorAccess,
  allowInstructorPublicSales,
  maintenanceMode,
}) {
  const settings = {
    key: 'default',
    'payment.platformFeePercent': normalizePlatformFeePercent(
      platformFeePercent,
      getDefaultPlatformFeePercent()
    ),
    'general.platformName': normalizeTrimmedString(platformName, getDefaultPlatformName()),
    'general.supportEmail': normalizeTrimmedString(
      supportEmail,
      getDefaultSupportEmail()
    ).toLowerCase(),
    'access.allowStudentRegistrations': normalizeBooleanSetting(
      allowStudentRegistrations,
      getDefaultAllowStudentRegistrations()
    ),
    'access.allowInstructorRegistrations': normalizeBooleanSetting(
      allowInstructorRegistrations,
      getDefaultAllowInstructorRegistrations()
    ),
    'access.allowInstructorCreatorAccess': normalizeBooleanSetting(
      allowInstructorCreatorAccess,
      getDefaultAllowInstructorCreatorAccess()
    ),
    'access.allowInstructorPublicSales': normalizeBooleanSetting(
      allowInstructorPublicSales,
      getDefaultAllowInstructorPublicSales()
    ),
    'access.maintenanceMode': normalizeBooleanSetting(
      maintenanceMode,
      getDefaultMaintenanceMode()
    ),
  };

  return PlatformSettings.findOneAndUpdate(
    { key: 'default' },
    {
      $set: settings,
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );
}

function isRegistrationAllowedForRole(role, settings) {
  if (role === 'admin') {
    return true;
  }

  const serialized = serializePlatformSettings(settings);
  if (role === 'instructor') {
    return serialized.allowInstructorRegistrations;
  }

  return serialized.allowStudentRegistrations;
}

function calculateMarketplaceBreakdown(amount, platformFeePercent) {
  const normalizedAmount = Number(Number(amount || 0).toFixed(2));
  const normalizedPercent = normalizePlatformFeePercent(
    platformFeePercent,
    getDefaultPlatformFeePercent()
  );
  const platformFeeAmount = Number(
    Math.min(normalizedAmount, normalizedAmount * (normalizedPercent / 100)).toFixed(2)
  );
  const instructorAmount = Number(Math.max(0, normalizedAmount - platformFeeAmount).toFixed(2));

  return {
    amount: normalizedAmount,
    platformFeePercent: normalizedPercent,
    platformFeeAmount,
    instructorAmount,
  };
}

function serializePlatformSettings(settings) {
  return {
    platformFeePercent: normalizePlatformFeePercent(
      settings?.payment?.platformFeePercent,
      getDefaultPlatformFeePercent()
    ),
    platformName: normalizeTrimmedString(
      settings?.general?.platformName,
      getDefaultPlatformName()
    ),
    supportEmail: normalizeTrimmedString(
      settings?.general?.supportEmail,
      getDefaultSupportEmail()
    ).toLowerCase(),
    allowStudentRegistrations: normalizeBooleanSetting(
      settings?.access?.allowStudentRegistrations,
      getDefaultAllowStudentRegistrations()
    ),
    allowInstructorRegistrations: normalizeBooleanSetting(
      settings?.access?.allowInstructorRegistrations,
      getDefaultAllowInstructorRegistrations()
    ),
    allowInstructorCreatorAccess: normalizeBooleanSetting(
      settings?.access?.allowInstructorCreatorAccess,
      getDefaultAllowInstructorCreatorAccess()
    ),
    allowInstructorPublicSales: normalizeBooleanSetting(
      settings?.access?.allowInstructorPublicSales,
      getDefaultAllowInstructorPublicSales()
    ),
    maintenanceMode: normalizeBooleanSetting(
      settings?.access?.maintenanceMode,
      getDefaultMaintenanceMode()
    ),
  };
}

module.exports = {
  calculateMarketplaceBreakdown,
  getDefaultPlatformFeePercent,
  getDefaultPlatformName,
  getDefaultSupportEmail,
  getPlatformFeePercent,
  getPlatformSettings,
  isRegistrationAllowedForRole,
  normalizePlatformFeePercent,
  serializePlatformSettings,
  updatePlatformSettings,
  updatePlatformPaymentSettings,
};
