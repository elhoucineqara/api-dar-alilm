const express = require('express');
const router = express.Router();
const Module = require('../models/Module');
const Quiz = require('../models/Quiz');
const Question = require('../models/Question');
const Answer = require('../models/Answer');
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

// --- Module Quizzes ---

// GET a single quiz by ID (for both instructors and students)
router.get('/:id', async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id)
      .populate({
        path: 'questions',
        populate: { path: 'answers' },
        options: { sort: { order: 1 } }
      })
      .lean();
    
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    
    res.json({ quiz });
  } catch (error) {
    console.error('Error fetching quiz:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid quiz ID' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET quiz for a module
router.get('/module/:moduleId', isInstructor, async (req, res) => {
  try {
    const module = await Module.findById(req.params.moduleId).populate('quiz');
    if (!module) {
      return res.status(404).json({ error: 'Module not found' });
    }

    const course = await Course.findOne({ _id: module.courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!module.quiz) {
      return res.json({ quiz: null });
    }

    const quiz = await Quiz.findById(module.quiz).populate({
      path: 'questions',
      populate: { path: 'answers' },
    });

    res.json({ quiz });
  } catch (error) {
    console.error('Error fetching quiz:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST create or update quiz for a module
router.post('/module/:moduleId', isInstructor, async (req, res) => {
  try {
    const module = await Module.findById(req.params.moduleId);
    if (!module) {
      return res.status(404).json({ error: 'Module not found' });
    }

    const course = await Course.findOne({ _id: module.courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { title, description, passingScore, timeLimit } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'Quiz title is required' });
    }

    let quiz;
    if (module.quiz) {
      quiz = await Quiz.findById(module.quiz);
      if (quiz) {
        quiz.title = title;
        quiz.description = description;
        quiz.passingScore = passingScore || 60;
        quiz.timeLimit = timeLimit;
        await quiz.save();
      }
    }

    if (!quiz) {
      quiz = new Quiz({
        title,
        description,
        moduleId: req.params.moduleId,
        isFinalExam: false,
        passingScore: passingScore || 60,
        timeLimit,
        questions: [],
        totalPoints: 0,
      });
      await quiz.save();
      module.quiz = quiz._id;
      await module.save();
    }

    res.json({ quiz });
  } catch (error) {
    console.error('Error creating/updating quiz:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE quiz for a module
router.delete('/module/:moduleId', isInstructor, async (req, res) => {
  try {
    const module = await Module.findById(req.params.moduleId);
    if (!module) {
      return res.status(404).json({ error: 'Module not found' });
    }

    const course = await Course.findOne({ _id: module.courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!module.quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const quiz = await Quiz.findById(module.quiz);
    if (quiz) {
      const questions = await Question.find({ quizId: quiz._id });
      for (const question of questions) {
        await Answer.deleteMany({ questionId: question._id });
        await Question.findByIdAndDelete(question._id);
      }
      await Quiz.findByIdAndDelete(quiz._id);
    }

    module.quiz = undefined;
    await module.save();

    res.json({ message: 'Quiz deleted successfully' });
  } catch (error) {
    console.error('Error deleting quiz:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Final Exams ---

// GET final exam for a course
router.get('/course/:courseId/final-exam', isInstructor, async (req, res) => {
  try {
    const course = await Course.findOne({ _id: req.params.courseId, instructorId: req.user.userId }).populate('finalExam');
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    if (!course.finalExam) {
      return res.json({ quiz: null });
    }

    const quiz = await Quiz.findById(course.finalExam._id).populate({
      path: 'questions',
      populate: { path: 'answers' },
    });

    res.json({ quiz });
  } catch (error) {
    console.error('Error fetching final exam:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST create or update final exam for a course
router.post('/course/:courseId/final-exam', isInstructor, async (req, res) => {
  try {
    const course = await Course.findOne({ _id: req.params.courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const { title, description, passingScore, timeLimit } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    let quiz;
    if (course.finalExam) {
      quiz = await Quiz.findById(course.finalExam);
      if (quiz) {
        quiz.title = title;
        quiz.description = description;
        quiz.passingScore = passingScore || 60;
        quiz.timeLimit = timeLimit;
        await quiz.save();
      }
    }

    if (!quiz) {
      quiz = new Quiz({
        title,
        description,
        courseId: req.params.courseId,
        isFinalExam: true,
        passingScore: passingScore || 60,
        timeLimit,
        questions: [],
        totalPoints: 0,
      });
      await quiz.save();
      course.finalExam = quiz._id;
      await course.save();
    }

    res.json({ quiz });
  } catch (error) {
    console.error('Error creating/updating final exam:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE final exam
router.delete('/course/:courseId/final-exam', isInstructor, async (req, res) => {
  try {
    const course = await Course.findOne({ _id: req.params.courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    if (!course.finalExam) {
      return res.status(404).json({ error: 'Final exam not found' });
    }

    const quiz = await Quiz.findById(course.finalExam);
    if (quiz) {
      const questions = await Question.find({ quizId: quiz._id });
      for (const question of questions) {
        await Answer.deleteMany({ questionId: question._id });
        await Question.findByIdAndDelete(question._id);
      }
      await Quiz.findByIdAndDelete(quiz._id);
    }

    course.finalExam = undefined;
    await course.save();

    res.json({ message: 'Final exam deleted successfully' });
  } catch (error) {
    console.error('Error deleting final exam:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Questions ---

// GET questions for a quiz
router.get('/:quizId/questions', isInstructor, async (req, res) => {
  try {
    const questions = await Question.find({ quizId: req.params.quizId }).populate('answers').sort({ createdAt: 1 });
    res.json({ questions });
  } catch (error) {
    console.error('Error fetching questions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST create a question
router.post('/:quizId/questions', isInstructor, async (req, res) => {
  try {
    const { question, type, points } = req.body;
    if (!question || !type) {
      return res.status(400).json({ error: 'Question and type are required' });
    }

    const newQuestion = new Question({
      question,
      type,
      points: points || 1,
      quizId: req.params.quizId,
      answers: [],
    });

    await newQuestion.save();

    const quiz = await Quiz.findById(req.params.quizId);
    if (quiz) {
      quiz.questions.push(newQuestion._id);
      quiz.totalPoints += newQuestion.points;
      await quiz.save();
    }

    res.status(201).json({ question: newQuestion });
  } catch (error) {
    console.error('Error creating question:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Question Management (PUT, DELETE) ---

// GET a single question
router.get('/question/:id', isInstructor, async (req, res) => {
    try {
        const question = await Question.findById(req.params.id).populate('answers');
        if (!question) {
            return res.status(404).json({ error: 'Question not found' });
        }
        res.json({ question });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT update a question
router.put('/question/:id', isInstructor, async (req, res) => {
    try {
        const { question, type, points } = req.body;
        const updatedQuestion = await Question.findByIdAndUpdate(
            req.params.id,
            { question, type, points },
            { new: true }
        );
        res.json({ question: updatedQuestion });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE a question
router.delete('/question/:id', isInstructor, async (req, res) => {
    try {
        const question = await Question.findById(req.params.id);
        if (question) {
            const quiz = await Quiz.findById(question.quizId);
            if (quiz) {
                quiz.questions = quiz.questions.filter(q => q.toString() !== req.params.id);
                quiz.totalPoints -= question.points;
                await quiz.save();
            }
            await Answer.deleteMany({ questionId: req.params.id });
            await Question.findByIdAndDelete(req.params.id);
        }
        res.json({ message: 'Question deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- Answers ---

// POST create an answer
router.post('/question/:questionId/answers', isInstructor, async (req, res) => {
  try {
    const { answer, isCorrect, order } = req.body;
    const newAnswer = new Answer({
      answer,
      isCorrect,
      order: order || 0,
      questionId: req.params.questionId,
    });

    await newAnswer.save();

    const question = await Question.findById(req.params.questionId);
    if (question) {
      question.answers.push(newAnswer._id);
      await question.save();
    }

    res.status(201).json({ answer: newAnswer });
  } catch (error) {
    console.error('Error creating answer:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update an answer
router.put('/answer/:id', isInstructor, async (req, res) => {
    try {
        const { answer, isCorrect, order } = req.body;
        const updatedAnswer = await Answer.findByIdAndUpdate(
            req.params.id,
            { answer, isCorrect, order },
            { new: true }
        );
        res.json({ answer: updatedAnswer });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE an answer
router.delete('/answer/:id', isInstructor, async (req, res) => {
    try {
        const answer = await Answer.findById(req.params.id);
        if (answer) {
            const question = await Question.findById(answer.questionId);
            if (question) {
                question.answers = question.answers.filter(a => a.toString() !== req.params.id);
                await question.save();
            }
            await Answer.findByIdAndDelete(req.params.id);
        }
        res.json({ message: 'Answer deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
