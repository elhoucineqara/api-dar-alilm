const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { generateToken } = require('../lib/jwt');
const { verifyGoogleCredential } = require('../lib/google-auth');
const {
  assertAccountCanAuthenticate,
  getRegistrationRole,
  isReservedAdminEmail,
  normalizeEmail,
  serializeUser,
  syncReservedAdminRole,
} = require('../lib/auth-user');
const {
  getPlatformSettings,
  isRegistrationAllowedForRole,
  serializePlatformSettings,
} = require('../lib/platform-settings');
const { getAuthContextFromToken } = require('../lib/request-auth');
const { sendPasswordResetEmail } = require('../lib/password-reset');

function createAuthResponse(user, message) {
  const token = generateToken({
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
  });

  return {
    message,
    token,
    user: serializeUser(user),
  };
}

function getRegistrationDisabledMessage(role) {
  if (role === 'instructor') {
    return 'Instructor registration is currently closed. For now, only the platform admin can create, publish, and sell courses publicly.';
  }

  return 'Student registration is currently disabled by the platform admin.';
}

function getReservedAdminRegistrationMessage() {
  return 'The admin account is not created from the public registration page. Please sign in from the login page.';
}

// Registration Route
router.post('/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role } = req.body;
    const normalizedEmail = normalizeEmail(email);

    // Validation
    if (!normalizedEmail || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists with this email' });
    }

    if (isReservedAdminEmail(normalizedEmail)) {
      return res.status(403).json({ error: getReservedAdminRegistrationMessage() });
    }

    const userRole = getRegistrationRole(normalizedEmail, role);
    const settings = await getPlatformSettings();
    if (!isRegistrationAllowedForRole(userRole, settings)) {
      return res.status(403).json({ error: getRegistrationDisabledMessage(userRole) });
    }

    // Create user
    const user = await User.create({
      email: normalizedEmail,
      password,
      firstName,
      lastName,
      role: userRole,
    });

    res.status(201).json(createAuthResponse(user, 'User created successfully'));
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Login Route
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    let user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.password) {
      return res.status(400).json({ error: 'This account uses Google Sign-In. Please continue with Gmail.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    user = await syncReservedAdminRole(user);
    assertAccountCanAuthenticate(user);

    res.json(createAuthResponse(user, 'Login successful'));
  } catch (error) {
    console.error('Login error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error' });
  }
});

router.post('/google', async (req, res) => {
  try {
    const { credential, role, mode } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Google credential is required' });
    }

    const authMode = mode === 'register' ? 'register' : 'login';
    const googleProfile = await verifyGoogleCredential(credential);

    const [existingByGoogleId, existingByEmail] = await Promise.all([
      User.findOne({ googleId: googleProfile.googleId }),
      User.findOne({ email: googleProfile.email }),
    ]);

    if (
      existingByGoogleId &&
      existingByEmail &&
      existingByGoogleId._id.toString() !== existingByEmail._id.toString()
    ) {
      return res.status(409).json({
        error: 'A different account is already linked to this Google profile',
      });
    }

    let user = existingByGoogleId || existingByEmail;
    const requestedRole = getRegistrationRole(googleProfile.email, role);
    const isRegisterMode = authMode === 'register';

    if (isRegisterMode && user) {
      return res.status(400).json({
        error: 'User already exists with this email. Please sign in instead.',
      });
    }

    if (!isRegisterMode && !user) {
      return res.status(404).json({
        error: 'No account found for this Gmail address. Please create a student account first.',
      });
    }

    if (isRegisterMode && isReservedAdminEmail(googleProfile.email)) {
      return res.status(403).json({
        error: getReservedAdminRegistrationMessage(),
      });
    }

    if (isRegisterMode) {
      const settings = await getPlatformSettings();
      if (!isRegistrationAllowedForRole(requestedRole, settings)) {
        return res.status(403).json({ error: getRegistrationDisabledMessage(requestedRole) });
      }
    }

    let created = false;

    if (!user) {
      user = new User({
        email: googleProfile.email,
        firstName: googleProfile.firstName,
        lastName: googleProfile.lastName,
        role: requestedRole,
        googleId: googleProfile.googleId,
        profileImage: googleProfile.picture,
      });
      created = true;
    } else {
      user.googleId = user.googleId || googleProfile.googleId;
      user.firstName = user.firstName || googleProfile.firstName;
      user.lastName = user.lastName || googleProfile.lastName;

      if (!user.profileImage && googleProfile.picture) {
        user.profileImage = googleProfile.picture;
      }
    }

    user.role = created ? requestedRole : user.role;

    await user.save();
    user = await syncReservedAdminRole(user);
    assertAccountCanAuthenticate(user);

    res.status(created ? 201 : 200).json(
      createAuthResponse(
        user,
        created ? 'Google account created successfully' : 'Google login successful'
      )
    );
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Google authentication failed' });
  }
});

const crypto = require('crypto');

// ... existing routes ...

router.get('/platform-access', async (req, res) => {
  try {
    const settings = serializePlatformSettings(await getPlatformSettings());

    return res.json({
      access: {
        allowStudentRegistrations: settings.allowStudentRegistrations,
        allowInstructorRegistrations: settings.allowInstructorRegistrations,
        allowInstructorCreatorAccess: settings.allowInstructorCreatorAccess,
        allowInstructorPublicSales: settings.allowInstructorPublicSales,
        maintenanceMode: settings.maintenanceMode,
      },
    });
  } catch (error) {
    console.error('Platform access error:', error);
    return res.status(500).json({
      error: 'Unable to load platform access settings.',
    });
  }
});

// Get current user
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);
    const { user } = await getAuthContextFromToken(token);

    res.json({
      user: serializeUser(user),
    });
  } catch (error) {
    console.error('Auth check error:', error);
    res.status(error.statusCode || 401).json({ error: error.message || 'Invalid token' });
  }
});

// Forgot Password Route
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await User.findOne({ email: normalizeEmail(email) });
    
    // For security, always return success message even if user doesn't exist
    if (!user) {
      return res.json({ 
        message: 'If an account with that email exists, a password reset link has been sent.' 
      });
    }

    const { resetUrl } = await sendPasswordResetEmail(user);

    console.log('='.repeat(80));
    console.log('PASSWORD RESET REQUESTED');
    console.log(`User: ${user.email}`);
    console.log(`Reset URL: ${resetUrl}`);
    console.log('='.repeat(80));

    res.json({ 
      message: 'If an account with that email exists, a password reset link has been sent to your email.' 
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'An error occurred. Please try again later.' });
  }
});

// Reset Password Route
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const hashedToken = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'An error occurred. Please try again later.' });
  }
});

module.exports = router;
