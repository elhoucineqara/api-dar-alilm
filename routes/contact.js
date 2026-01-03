const express = require('express');
const router = express.Router();
const Contact = require('../models/Contact');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// @route   POST /api/contact
// @desc    Submit a contact form
// @access  Public
router.post('/', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    // Validation
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide all required fields: name, email, subject, message' 
      });
    }

    // Create contact
    const contact = new Contact({
      name,
      email,
      subject,
      message,
    });

    await contact.save();

    res.status(201).json({
      success: true,
      message: 'Your message has been sent successfully. We will get back to you soon!',
      data: {
        _id: contact._id,
        name: contact.name,
        email: contact.email,
        subject: contact.subject,
        createdAt: contact.createdAt,
      },
    });
  } catch (error) {
    console.error('Contact submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit contact form',
      error: error.message,
    });
  }
});

// @route   GET /api/contact
// @desc    Get all contact submissions (Admin only)
// @access  Private (Admin)
router.get('/', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const query = {};
    if (status) {
      query.status = status;
    }

    const contacts = await Contact.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Contact.countDocuments(query);

    res.json({
      success: true,
      data: contacts,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch contacts',
      error: error.message,
    });
  }
});

// @route   GET /api/contact/:id
// @desc    Get a single contact submission (Admin only)
// @access  Private (Admin)
router.get('/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id).populate('repliedBy', 'firstName lastName email');

    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact submission not found',
      });
    }

    // Mark as read if it was new
    if (contact.status === 'new') {
      contact.status = 'read';
      await contact.save();
    }

    res.json({
      success: true,
      data: contact,
    });
  } catch (error) {
    console.error('Get contact error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch contact',
      error: error.message,
    });
  }
});

// @route   PUT /api/contact/:id/reply
// @desc    Reply to a contact submission (Admin only)
// @access  Private (Admin)
router.put('/:id/reply', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { reply } = req.body;

    if (!reply) {
      return res.status(400).json({
        success: false,
        message: 'Reply message is required',
      });
    }

    const contact = await Contact.findById(req.params.id);

    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact submission not found',
      });
    }

    contact.reply = reply;
    contact.status = 'replied';
    contact.repliedAt = new Date();
    contact.repliedBy = req.user.userId;

    await contact.save();

    res.json({
      success: true,
      message: 'Reply sent successfully',
      data: contact,
    });
  } catch (error) {
    console.error('Reply contact error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send reply',
      error: error.message,
    });
  }
});

// @route   DELETE /api/contact/:id
// @desc    Delete a contact submission (Admin only)
// @access  Private (Admin)
router.delete('/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);

    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact submission not found',
      });
    }

    await contact.deleteOne();

    res.json({
      success: true,
      message: 'Contact submission deleted successfully',
    });
  } catch (error) {
    console.error('Delete contact error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete contact',
      error: error.message,
    });
  }
});

module.exports = router;

