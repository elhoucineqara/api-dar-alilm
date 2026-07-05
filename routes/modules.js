const express = require('express');
const router = express.Router();
const Course = require('../models/Course');
const Module = require('../models/Module');
const { requireCreatorUser } = require('../lib/creator-access');

// GET all modules for a course
router.get('/:courseId', requireCreatorUser, async (req, res) => {
  try {
    const { courseId } = req.params;

    const course = await Course.findOne({ _id: courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const modules = await Module.find({ courseId: courseId })
      .populate('sections')
      .populate('quiz')
      .sort({ order: 1 });
    
    res.json({ modules });
  } catch (error) {
    console.error('Error fetching modules:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST create a new module
router.post('/:courseId', requireCreatorUser, async (req, res) => {
  try {
    const { courseId } = req.params;
    const { title, description, order } = req.body;

    const course = await Course.findOne({ _id: courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    if (!title) {
      return res.status(400).json({ error: 'Module title is required' });
    }

    const moduleOrder = order !== undefined ? order : course.modules.length;

    const module = new Module({
      title,
      description,
      courseId: courseId,
      order: moduleOrder,
      sections: [],
    });

    await module.save();

    course.modules.push(module._id);
    await course.save();

    res.status(201).json({ module });
  } catch (error) {
    console.error('Error creating module:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update a module
router.put('/:moduleId', requireCreatorUser, async (req, res) => {
  try {
    const { moduleId } = req.params;
    const { title, description, order } = req.body;

    const module = await Module.findById(moduleId);
    if (!module) {
      return res.status(404).json({ error: 'Module not found' });
    }

    // Verify course belongs to instructor
    const course = await Course.findOne({ _id: module.courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (title) module.title = title;
    if (description !== undefined) module.description = description;
    if (order !== undefined) module.order = order;

    await module.save();
    res.json({ module });
  } catch (error) {
    console.error('Error updating module:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE a module
router.delete('/:moduleId', requireCreatorUser, async (req, res) => {
  try {
    const { moduleId } = req.params;

    const module = await Module.findById(moduleId);
    if (!module) {
      return res.status(404).json({ error: 'Module not found' });
    }

    const course = await Course.findOne({ _id: module.courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Remove from course
    course.modules = course.modules.filter(m => m.toString() !== moduleId);
    await course.save();

    await Module.findByIdAndDelete(moduleId);
    res.json({ message: 'Module deleted successfully' });
  } catch (error) {
    console.error('Error deleting module:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
