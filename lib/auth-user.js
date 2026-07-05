const RESERVED_ADMIN_EMAILS = new Set(['mohamedqara@gmail.com']);

function normalizeEmail(email = '') {
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');

  if (atIndex <= 0) {
    return normalized;
  }

  let localPart = normalized.slice(0, atIndex);
  let domainPart = normalized.slice(atIndex + 1);

  if (domainPart === 'googlemail.com') {
    domainPart = 'gmail.com';
  }

  // Gmail ignores dots in the local part, so we normalize aliases to one account.
  if (domainPart === 'gmail.com') {
    localPart = localPart.replace(/\./g, '');
  }

  return `${localPart}@${domainPart}`;
}

function isReservedAdminEmail(email = '') {
  return RESERVED_ADMIN_EMAILS.has(normalizeEmail(email));
}

function sanitizePublicRole(role) {
  return role === 'instructor' ? 'instructor' : 'student';
}

function getAccountStatus(user) {
  return user?.accountStatus || 'active';
}

function getRegistrationRole(email, requestedRole) {
  if (isReservedAdminEmail(email)) {
    return 'admin';
  }

  return sanitizePublicRole(requestedRole);
}

async function syncReservedAdminRole(user) {
  if (!user || user.role === 'admin' || !isReservedAdminEmail(user.email)) {
    return user;
  }

  user.role = 'admin';
  await user.updateOne({ $set: { role: 'admin' } });

  return user;
}

function assertAccountCanAuthenticate(user) {
  const accountStatus = getAccountStatus(user);

  if (accountStatus === 'blocked') {
    const error = new Error(
      'This account has been blocked. Please contact the platform administrator.'
    );
    error.statusCode = 403;
    error.code = 'ACCOUNT_BLOCKED';
    throw error;
  }

  if (accountStatus === 'deleted') {
    const error = new Error('This account is no longer available.');
    error.statusCode = 403;
    error.code = 'ACCOUNT_DELETED';
    throw error;
  }

  return true;
}

function serializeUser(user) {
  return {
    id: user._id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    phone: user.phone,
    bio: user.bio,
    profileImage: user.profileImage,
    accountStatus: getAccountStatus(user),
    customPlatformFeePercent:
      user.customPlatformFeePercent !== undefined ? user.customPlatformFeePercent : null,
  };
}

module.exports = {
  assertAccountCanAuthenticate,
  getAccountStatus,
  getRegistrationRole,
  isReservedAdminEmail,
  normalizeEmail,
  serializeUser,
  syncReservedAdminRole,
};
