const express = require('express');
const router = express.Router();
const Module = require('../models/Module');
const Quiz = require('../models/Quiz');
const Question = require('../models/Question');
const Answer = require('../models/Answer');
const Course = require('../models/Course');
const { requireCreatorUser } = require('../lib/creator-access');

function getSanitizedQuestionFields(body) {
  const { question, type, points, imageId, imageUrl, imageName } = body;
  return {
    question,
    type,
    points: points || 1,
    imageId: imageId || undefined,
    imageUrl: imageUrl || undefined,
    imageName: imageName || undefined,
  };
}

async function createQuestionWithAnswers(quizId, payload, order = 0) {
  const { question, type, points, imageId, imageUrl, imageName } = getSanitizedQuestionFields(payload);
  if (!question || !type) {
    throw new Error('Question and type are required');
  }

  const newQuestion = new Question({
    question,
    type,
    points: points || 1,
    quizId,
    order,
    imageId,
    imageUrl,
    imageName,
    answers: [],
  });

  await newQuestion.save();

  const answers = Array.isArray(payload.answers) ? payload.answers : [];
  for (let index = 0; index < answers.length; index += 1) {
    const answerPayload = answers[index];
    const newAnswer = new Answer({
      answer: answerPayload.answer || answerPayload.text,
      matchText: answerPayload.matchText || answerPayload.right || undefined,
      isCorrect: Boolean(answerPayload.isCorrect),
      order: answerPayload.order !== undefined ? answerPayload.order : index,
      questionId: newQuestion._id,
    });
    await newAnswer.save();
    newQuestion.answers.push(newAnswer._id);
  }

  await newQuestion.save();

  const quiz = await Quiz.findById(quizId);
  if (quiz) {
    quiz.questions.push(newQuestion._id);
    quiz.totalPoints += newQuestion.points;
    await quiz.save();
  }

  return newQuestion;
}

async function deleteQuestionWithAnswers(questionId) {
  const question = await Question.findById(questionId);
  if (!question) return null;

  await Answer.deleteMany({ questionId });
  await Question.findByIdAndDelete(questionId);
  return question;
}

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
router.get('/module/:moduleId', requireCreatorUser, async (req, res) => {
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
router.post('/module/:moduleId', requireCreatorUser, async (req, res) => {
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
router.delete('/module/:moduleId', requireCreatorUser, async (req, res) => {
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
router.get('/course/:courseId/final-exam', requireCreatorUser, async (req, res) => {
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
router.post('/course/:courseId/final-exam', requireCreatorUser, async (req, res) => {
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
router.delete('/course/:courseId/final-exam', requireCreatorUser, async (req, res) => {
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
router.get('/:quizId/questions', requireCreatorUser, async (req, res) => {
  try {
    const questions = await Question.find({ quizId: req.params.quizId })
      .populate({ path: 'answers', options: { sort: { order: 1 } } })
      .sort({ order: 1, createdAt: 1 });
    res.json({ questions });
  } catch (error) {
    console.error('Error fetching questions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET quiz questions as an importable JSON payload
router.get('/:quizId/export', requireCreatorUser, async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId).lean();
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const questions = await Question.find({ quizId: req.params.quizId })
      .sort({ order: 1, createdAt: 1 })
      .lean();

    const payloadQuestions = await Promise.all(questions.map(async (question) => {
      const answers = await Answer.find({ questionId: question._id }).sort({ order: 1 }).lean();
      return {
        question: question.question,
        type: question.type,
        points: question.points,
        imageUrl: question.imageUrl,
        imageName: question.imageName,
        answers: answers.map((answer) => ({
          answer: answer.answer,
          matchText: answer.matchText,
          isCorrect: answer.isCorrect,
          order: answer.order,
        })),
      };
    }));

    res.json({
      version: 1,
      quiz: {
        title: quiz.title,
        description: quiz.description,
        passingScore: quiz.passingScore,
        timeLimit: quiz.timeLimit,
      },
      questions: payloadQuestions,
      template: {
        question: 'Classer les étapes HTTP dans le bon ordre',
        type: 'sequence',
        points: 1,
        answers: [
          { answer: 'Le client envoie une requête', isCorrect: true, order: 0 },
          { answer: 'Le serveur traite la demande', isCorrect: true, order: 1 },
          { answer: 'Le serveur envoie une réponse', isCorrect: true, order: 2 },
        ],
      },
    });
  } catch (error) {
    console.error('Error exporting quiz questions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST import quiz questions from a JSON payload
router.post('/:quizId/import', requireCreatorUser, async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const mode = req.body.mode === 'replace' ? 'replace' : 'append';
    const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
    if (questions.length === 0) {
      return res.status(400).json({ error: 'questions must be a non-empty array' });
    }

    if (mode === 'replace') {
      const existingQuestions = await Question.find({ quizId: quiz._id });
      for (const existingQuestion of existingQuestions) {
        await deleteQuestionWithAnswers(existingQuestion._id);
      }
      quiz.questions = [];
      quiz.totalPoints = 0;
      await quiz.save();
    }

    const currentCount = await Question.countDocuments({ quizId: quiz._id });
    const createdQuestions = [];
    for (let index = 0; index < questions.length; index += 1) {
      createdQuestions.push(await createQuestionWithAnswers(quiz._id, questions[index], currentCount + index));
    }

    res.status(201).json({
      message: `${createdQuestions.length} question(s) imported`,
      count: createdQuestions.length,
    });
  } catch (error) {
    console.error('Error importing quiz questions:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST create a question
router.post('/:quizId/questions', requireCreatorUser, async (req, res) => {
  try {
    const { question, type, points, imageId, imageUrl, imageName } = req.body;
    if (!question || !type) {
      return res.status(400).json({ error: 'Question and type are required' });
    }

    const questionCount = await Question.countDocuments({ quizId: req.params.quizId });

    const newQuestion = new Question({
      question,
      type,
      points: points || 1,
      quizId: req.params.quizId,
      order: questionCount,
      imageId: imageId || undefined,
      imageUrl: imageUrl || undefined,
      imageName: imageName || undefined,
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
router.get('/question/:id', requireCreatorUser, async (req, res) => {
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
router.put('/question/:id', requireCreatorUser, async (req, res) => {
    try {
        const { question, type, points, imageId, imageUrl, imageName } = req.body;
        const updatedQuestion = await Question.findByIdAndUpdate(
            req.params.id,
            { question, type, points, imageId, imageUrl, imageName },
            { new: true }
        );
        res.json({ question: updatedQuestion });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE a question
router.delete('/question/:id', requireCreatorUser, async (req, res) => {
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
router.post('/question/:questionId/answers', requireCreatorUser, async (req, res) => {
  try {
    const { answer, isCorrect, order, matchText } = req.body;
    const question = await Question.findById(req.params.questionId);
    if (!question) {
      return res.status(404).json({ error: 'Question not found' });
    }

    if (isCorrect && ['qcm', 'single_choice', 'true_false', 'quiz_image'].includes(question.type)) {
      await Answer.updateMany({ questionId: req.params.questionId }, { isCorrect: false });
    }

    const newAnswer = new Answer({
      answer,
      matchText,
      isCorrect,
      order: order || 0,
      questionId: req.params.questionId,
    });

    await newAnswer.save();

    question.answers.push(newAnswer._id);
    await question.save();

    res.status(201).json({ answer: newAnswer });
  } catch (error) {
    console.error('Error creating answer:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update an answer
router.put('/answer/:id', requireCreatorUser, async (req, res) => {
    try {
        const { answer, isCorrect, order, matchText } = req.body;
        const existingAnswer = await Answer.findById(req.params.id);
        if (!existingAnswer) {
          return res.status(404).json({ error: 'Answer not found' });
        }

        const question = await Question.findById(existingAnswer.questionId);
        if (isCorrect && question && ['qcm', 'single_choice', 'true_false', 'quiz_image'].includes(question.type)) {
          await Answer.updateMany({ questionId: question._id, _id: { $ne: req.params.id } }, { isCorrect: false });
        }

        const updatedAnswer = await Answer.findByIdAndUpdate(
            req.params.id,
            { answer, isCorrect, order, matchText },
            { new: true }
        );
        res.json({ answer: updatedAnswer });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE an answer
router.delete('/answer/:id', requireCreatorUser, async (req, res) => {
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
