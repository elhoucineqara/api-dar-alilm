const express = require('express');
const router = express.Router();
const Module = require('../models/Module');
const Section = require('../models/Section');
const Course = require('../models/Course');
const { verifyToken } = require('../lib/jwt');

// Middleware to protect instructor routes
const isInstructor = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    const decoded = verifyToken(token);
    if (decoded.role !== 'instructor') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

// GET all sections for a module
router.get('/module/:moduleId', isInstructor, async (req, res) => {
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

    const sections = await Section.find({ moduleId }).sort({ order: 1 });
    res.json({ sections });
  } catch (error) {
    console.error('Error fetching sections:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST create a new section
router.post('/module/:moduleId', isInstructor, async (req, res) => {
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

    const { title, description, type, order, fileId, fileUrl, fileName, fileType, youtubeUrl } = req.body;

    if (!title || !type) {
      return res.status(400).json({ error: 'Title and type are required' });
    }

    const sectionOrder = order !== undefined ? order : module.sections.length;

    const section = new Section({
      title,
      description,
      moduleId,
      type,
      order: sectionOrder,
      fileId: type === 'file' ? fileId : undefined,
      fileUrl: type === 'file' ? fileUrl : undefined,
      fileName: type === 'file' ? fileName : undefined,
      fileType: type === 'file' ? fileType : undefined,
      youtubeUrl: type === 'youtube' ? youtubeUrl : undefined,
    });

    await section.save();

    module.sections.push(section._id);
    await module.save();

    res.status(201).json({ section });
  } catch (error) {
    console.error('Error creating section:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET a single section
router.get('/:id', isInstructor, async (req, res) => {
  try {
    const section = await Section.findById(req.params.id);
    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }

    const module = await Module.findById(section.moduleId);
    const course = await Course.findOne({ _id: module.courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json({ section });
  } catch (error) {
    console.error('Error fetching section:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update a section
router.put('/:id', isInstructor, async (req, res) => {
  try {
    const section = await Section.findById(req.params.id);
    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }

    const module = await Module.findById(section.moduleId);
    const course = await Course.findOne({ _id: module.courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { title, description, type, order, fileId, fileUrl, fileName, fileType, youtubeUrl } = req.body;

    const updateData = {};
    if (title) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (type) updateData.type = type;
    if (order !== undefined) updateData.order = order;
    if (fileId !== undefined) updateData.fileId = fileId;
    if (fileUrl !== undefined) updateData.fileUrl = fileUrl;
    if (fileName !== undefined) updateData.fileName = fileName;
    if (fileType !== undefined) updateData.fileType = fileType;
    if (youtubeUrl !== undefined) updateData.youtubeUrl = youtubeUrl;

    const updatedSection = await Section.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    res.json({ section: updatedSection });
  } catch (error) {
    console.error('Error updating section:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE a section
router.delete('/:id', isInstructor, async (req, res) => {
  try {
    const section = await Section.findById(req.params.id);
    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }

    const module = await Module.findById(section.moduleId);
    const course = await Course.findOne({ _id: module.courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    module.sections = module.sections.filter((s) => s.toString() !== req.params.id);
    await module.save();

    await Section.findByIdAndDelete(req.params.id);

    res.json({ message: 'Section deleted successfully' });
  } catch (error) {
    console.error('Error deleting section:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
