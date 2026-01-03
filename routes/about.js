const express = require('express');
const router = express.Router();
const About = require('../models/About');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// @route   GET /api/about
// @desc    Get active about page content
// @access  Public
router.get('/', async (req, res) => {
  try {
    // Get the active about page content
    const about = await About.findOne({ isActive: true }).sort({ createdAt: -1 });

    if (!about) {
      // Return default content if none exists
      return res.json({
        success: true,
        data: {
          title: 'About Dar Al-Ilm',
          subtitle: 'Your Trusted Partner in Online Learning',
          description: 'Dar Al-Ilm is a comprehensive learning management system designed to deliver high-quality education to students worldwide.',
          mission: 'To provide accessible, affordable, and high-quality education to learners around the globe.',
          vision: 'To become the leading platform for online education and skill development.',
          values: [],
          team: [],
          stats: [],
        },
      });
    }

    res.json({
      success: true,
      data: about,
    });
  } catch (error) {
    console.error('Get about error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch about page',
      error: error.message,
    });
  }
});

// @route   POST /api/about
// @desc    Create about page content (Admin only)
// @access  Private (Admin)
router.post('/', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { title, subtitle, description, mission, vision, values, team, stats } = req.body;

    // Validation
    if (!title || !description) {
      return res.status(400).json({
        success: false,
        message: 'Title and description are required',
      });
    }

    // Deactivate all previous about pages
    await About.updateMany({}, { isActive: false });

    // Create new about page
    const about = new About({
      title,
      subtitle,
      description,
      mission,
      vision,
      values,
      team,
      stats,
      isActive: true,
    });

    await about.save();

    res.status(201).json({
      success: true,
      message: 'About page created successfully',
      data: about,
    });
  } catch (error) {
    console.error('Create about error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create about page',
      error: error.message,
    });
  }
});

// @route   PUT /api/about/:id
// @desc    Update about page content (Admin only)
// @access  Private (Admin)
router.put('/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { title, subtitle, description, mission, vision, values, team, stats, isActive } = req.body;

    const about = await About.findById(req.params.id);

    if (!about) {
      return res.status(404).json({
        success: false,
        message: 'About page not found',
      });
    }

    // If setting this page as active, deactivate all others
    if (isActive === true) {
      await About.updateMany({ _id: { $ne: req.params.id } }, { isActive: false });
    }

    // Update fields
    if (title !== undefined) about.title = title;
    if (subtitle !== undefined) about.subtitle = subtitle;
    if (description !== undefined) about.description = description;
    if (mission !== undefined) about.mission = mission;
    if (vision !== undefined) about.vision = vision;
    if (values !== undefined) about.values = values;
    if (team !== undefined) about.team = team;
    if (stats !== undefined) about.stats = stats;
    if (isActive !== undefined) about.isActive = isActive;

    await about.save();

    res.json({
      success: true,
      message: 'About page updated successfully',
      data: about,
    });
  } catch (error) {
    console.error('Update about error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update about page',
      error: error.message,
    });
  }
});

// @route   GET /api/about/all
// @desc    Get all about pages (Admin only)
// @access  Private (Admin)
router.get('/all', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const aboutPages = await About.find().sort({ createdAt: -1 });

    res.json({
      success: true,
      data: aboutPages,
    });
  } catch (error) {
    console.error('Get all about pages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch about pages',
      error: error.message,
    });
  }
});

// @route   DELETE /api/about/:id
// @desc    Delete about page (Admin only)
// @access  Private (Admin)
router.delete('/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const about = await About.findById(req.params.id);

    if (!about) {
      return res.status(404).json({
        success: false,
        message: 'About page not found',
      });
    }

    await about.deleteOne();

    res.json({
      success: true,
      message: 'About page deleted successfully',
    });
  } catch (error) {
    console.error('Delete about error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete about page',
      error: error.message,
    });
  }
});

module.exports = router;

