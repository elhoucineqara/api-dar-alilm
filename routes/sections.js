const express = require('express');
const router = express.Router();
const Module = require('../models/Module');
const Section = require('../models/Section');
const Course = require('../models/Course');
const Quiz = require('../models/Quiz');
const Question = require('../models/Question');
const Answer = require('../models/Answer');
const { requireCreatorUser } = require('../lib/creator-access');

async function createSectionQuiz({ moduleId, title, description, passingScore, timeLimit }) {
  const quiz = new Quiz({
    title,
    description,
    moduleId,
    isFinalExam: false,
    passingScore: passingScore || 60,
    timeLimit,
    questions: [],
    totalPoints: 0,
  });

  await quiz.save();
  return quiz;
}

async function deleteQuizIfOnlyUsedBySection(quizId) {
  if (!quizId) return;

  const [otherSection, legacyModule] = await Promise.all([
    Section.findOne({ quizId }),
    Module.findOne({ quiz: quizId }),
  ]);

  if (otherSection || legacyModule) return;

  const questions = await Question.find({ quizId });
  for (const question of questions) {
    await Answer.deleteMany({ questionId: question._id });
    await Question.findByIdAndDelete(question._id);
  }
  await Quiz.findByIdAndDelete(quizId);
}

// GET all sections for a module
router.get('/module/:moduleId', requireCreatorUser, async (req, res) => {
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
router.post('/module/:moduleId', requireCreatorUser, async (req, res) => {
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

    const {
      title,
      description,
      type,
      order,
      fileId,
      fileUrl,
      fileName,
      fileType,
      youtubeUrl,
      articleContent,
      quizId,
      quizTitle,
      quizDescription,
      passingScore,
      timeLimit,
    } = req.body;

    if (!title || !type) {
      return res.status(400).json({ error: 'Title and type are required' });
    }

    const sectionOrder = order !== undefined ? order : module.sections.length;

    let resolvedQuizId = quizId;
    if (type === 'quiz' && !resolvedQuizId) {
      const quiz = await createSectionQuiz({
        moduleId,
        title: quizTitle || title,
        description: quizDescription || description,
        passingScore,
        timeLimit,
      });
      resolvedQuizId = quiz._id;
    }

    const section = new Section({
      title,
      description,
      moduleId,
      type,
      order: sectionOrder,
      fileId: type === 'file' || type === 'video' ? fileId : undefined,
      fileUrl: type === 'file' || type === 'video' ? fileUrl : undefined,
      fileName: type === 'file' || type === 'video' ? fileName : undefined,
      fileType: type === 'video' ? 'video' : type === 'file' ? fileType : undefined,
      youtubeUrl: type === 'youtube' ? youtubeUrl : undefined,
      articleContent: type === 'article' ? articleContent : undefined,
      quizId: type === 'quiz' ? resolvedQuizId : undefined,
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

// PUT reorder sections inside a module
router.put('/module/:moduleId/reorder', requireCreatorUser, async (req, res) => {
  try {
    const { moduleId } = req.params;
    const { sectionIds } = req.body;

    if (!Array.isArray(sectionIds) || sectionIds.length === 0) {
      return res.status(400).json({ error: 'sectionIds must be a non-empty array' });
    }

    const module = await Module.findById(moduleId);
    if (!module) {
      return res.status(404).json({ error: 'Module not found' });
    }

    const course = await Course.findOne({ _id: module.courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const moduleSectionIds = module.sections.map((id) => id.toString());
    const requestedSectionIds = sectionIds.map((id) => id.toString());
    const hasSameSections =
      requestedSectionIds.length === moduleSectionIds.length &&
      requestedSectionIds.every((id) => moduleSectionIds.includes(id));

    if (!hasSameSections) {
      return res.status(400).json({ error: 'sectionIds must contain exactly the module sections' });
    }

    module.sections = requestedSectionIds;
    await module.save();

    await Promise.all(
      requestedSectionIds.map((sectionId, index) =>
        Section.findByIdAndUpdate(sectionId, { order: index })
      )
    );

    const sections = await Section.find({ moduleId }).sort({ order: 1 });
    res.json({ sections });
  } catch (error) {
    console.error('Error reordering sections:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET a single section
router.get('/:id', requireCreatorUser, async (req, res) => {
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
router.put('/:id', requireCreatorUser, async (req, res) => {
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

    const {
      title,
      description,
      type,
      order,
      fileId,
      fileUrl,
      fileName,
      fileType,
      youtubeUrl,
      articleContent,
      quizId,
      quizTitle,
      quizDescription,
      passingScore,
      timeLimit,
    } = req.body;

    const updateData = {};
    const unsetData = {};
    const oldQuizId = section.type === 'quiz' ? section.quizId : null;

    if (title) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (type) updateData.type = type;
    if (order !== undefined) updateData.order = order;
    if (fileId !== undefined) updateData.fileId = fileId;
    if (fileUrl !== undefined) updateData.fileUrl = fileUrl;
    if (fileName !== undefined) updateData.fileName = fileName;
    if (fileType !== undefined) updateData.fileType = fileType;
    if (youtubeUrl !== undefined) updateData.youtubeUrl = youtubeUrl;
    if (articleContent !== undefined) updateData.articleContent = articleContent;
    if (quizId !== undefined) updateData.quizId = quizId;

    if (type === 'video') {
      updateData.fileType = 'video';
      unsetData.youtubeUrl = '';
      unsetData.articleContent = '';
      unsetData.quizId = '';
    } else if (type === 'file') {
      unsetData.youtubeUrl = '';
      unsetData.articleContent = '';
      unsetData.quizId = '';
    } else if (type === 'youtube') {
      unsetData.fileId = '';
      unsetData.fileUrl = '';
      unsetData.fileName = '';
      unsetData.fileType = '';
      unsetData.articleContent = '';
      unsetData.quizId = '';
    } else if (type === 'article') {
      unsetData.fileId = '';
      unsetData.fileUrl = '';
      unsetData.fileName = '';
      unsetData.fileType = '';
      unsetData.youtubeUrl = '';
      unsetData.quizId = '';
    } else if (type === 'quiz') {
      unsetData.fileId = '';
      unsetData.fileUrl = '';
      unsetData.fileName = '';
      unsetData.fileType = '';
      unsetData.youtubeUrl = '';
      unsetData.articleContent = '';

      if (!updateData.quizId && !section.quizId) {
        const quiz = await createSectionQuiz({
          moduleId: section.moduleId,
          title: quizTitle || title || section.title,
          description: quizDescription || description || section.description,
          passingScore,
          timeLimit,
        });
        updateData.quizId = quiz._id;
      }
    }

    const shouldDeleteOldQuiz = oldQuizId && (
      (type && type !== 'quiz') ||
      (quizId !== undefined && String(quizId) !== String(oldQuizId))
    );

    const updatedSection = await Section.findByIdAndUpdate(
      req.params.id,
      Object.keys(unsetData).length > 0 ? { $set: updateData, $unset: unsetData } : updateData,
      { new: true, runValidators: true }
    );

    if (shouldDeleteOldQuiz) {
      await deleteQuizIfOnlyUsedBySection(oldQuizId);
    }

    res.json({ section: updatedSection });
  } catch (error) {
    console.error('Error updating section:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE a section
router.delete('/:id', requireCreatorUser, async (req, res) => {
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

    const quizIdToDelete = section.type === 'quiz' ? section.quizId : null;
    await Section.findByIdAndDelete(req.params.id);
    await deleteQuizIfOnlyUsedBySection(quizIdToDelete);

    res.json({ message: 'Section deleted successfully' });
  } catch (error) {
    console.error('Error deleting section:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
