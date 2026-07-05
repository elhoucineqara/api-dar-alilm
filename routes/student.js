const express = require('express');
const router = express.Router();
const Enrollment = require('../models/Enrollment');
const Progress = require('../models/Progress');
const Course = require('../models/Course');
const Category = require('../models/Category');
const User = require('../models/User');
const Section = require('../models/Section');
const Module = require('../models/Module');
const Quiz = require('../models/Quiz');
const QuizAttempt = require('../models/QuizAttempt');
const Certificate = require('../models/Certificate');
const { requireAuthUser } = require('../lib/request-auth');
const { uploadFileToGridFS } = require('../lib/gridfs');
const { ensureEnrollmentAndProgress } = require('../lib/course-enrollment');
const {
  IMAGE_EXTENSIONS,
  createMemoryUpload,
  getUploadErrorResponse,
  validateUploadedFile,
} = require('../lib/secure-upload');

// Configure multer for file upload
const upload = createMemoryUpload(5 * 1024 * 1024);

function idSet(values = []) {
  return new Set(values.map((value) => String(value)));
}

async function getQuizCourseContext(quizId) {
  const quiz = await Quiz.findById(quizId)
    .populate({
      path: 'questions',
      populate: { path: 'answers' },
      options: { sort: { order: 1 } },
    })
    .lean();

  if (!quiz) {
    return null;
  }

  const finalExamCourse = await Course.findOne({ finalExam: quizId }).lean();
  if (finalExamCourse) {
    return {
      quiz,
      course: finalExamCourse,
      courseId: finalExamCourse._id,
      moduleId: null,
      isFinalExam: true,
    };
  }

  const module = await Module.findOne({ quiz: quizId }).lean();
  if (!module) {
    const section = await Section.findOne({ quizId }).lean();
    if (section) {
      const sectionModule = await Module.findById(section.moduleId).lean();
      const sectionCourse = sectionModule ? await Course.findById(sectionModule.courseId).lean() : null;
      return {
        quiz,
        course: sectionCourse,
        courseId: sectionModule?.courseId || quiz.courseId || null,
        moduleId: sectionModule?._id || quiz.moduleId || null,
        isFinalExam: false,
      };
    }

    return {
      quiz,
      course: null,
      courseId: quiz.courseId || null,
      moduleId: quiz.moduleId || null,
      isFinalExam: Boolean(quiz.isFinalExam),
    };
  }

  const course = await Course.findById(module.courseId).lean();
  return {
    quiz,
    course,
    courseId: module.courseId,
    moduleId: module._id,
    isFinalExam: false,
  };
}

async function loadQuizWithQuestions(quizId) {
  if (!quizId) return null;

  return Quiz.findById(quizId)
    .populate({
      path: 'questions',
      populate: { path: 'answers' },
      options: { sort: { order: 1 } },
    })
    .lean();
}

async function recalculateProgress(progress, courseId) {
  const course = await Course.findById(courseId).lean();
  const modules = await Module.find({ courseId }).lean();

  let totalSections = 0;
  let totalQuizzes = 0;
  let completedSectionsCount = 0;
  let completedQuizzesCount = 0;
  const moduleQuizIds = new Set();
  const contentSectionIds = new Set();

  for (const mod of modules) {
    const sections = await Section.find({ moduleId: mod._id }).select('_id type quizId').lean();
    for (const section of sections) {
      if (section.type === 'quiz' && section.quizId) {
        totalQuizzes += 1;
        moduleQuizIds.add(String(section.quizId));
      } else {
        totalSections += 1;
        contentSectionIds.add(String(section._id));
      }
    }

    if (mod.quiz) {
      totalQuizzes += 1;
      moduleQuizIds.add(String(mod.quiz));
    }
  }

  completedSectionsCount = progress.completedSections.filter((sectionId) =>
    contentSectionIds.has(String(sectionId))
  ).length;
  progress.completedSections = progress.completedSections.filter((sectionId) =>
    contentSectionIds.has(String(sectionId))
  );

  completedQuizzesCount = progress.completedQuizzes.filter((quizId) =>
    moduleQuizIds.has(String(quizId))
  ).length;
  progress.completedQuizzes = progress.completedQuizzes.filter((quizId) =>
    moduleQuizIds.has(String(quizId))
  );

  if (course?.finalExam) {
    totalQuizzes += 1;
    if (progress.completedFinalExam) completedQuizzesCount += 1;
  }

  const totalItems = totalSections + totalQuizzes;
  const completedItems = completedSectionsCount + completedQuizzesCount;

  progress.overallProgress = totalItems > 0
    ? Math.round((completedItems / totalItems) * 100)
    : 0;
  progress.lastAccessedAt = new Date();

  await progress.save();

  if (progress.overallProgress === 100) {
    const enrollment = await Enrollment.findOne({ userId: progress.userId, courseId });
    if (enrollment && enrollment.status === 'active') {
      enrollment.status = 'completed';
      enrollment.completedAt = new Date();
      await enrollment.save();
    }
  }

  return progress;
}

// Middleware to protect student routes
const isStudent = async (req, res, next) => {
  try {
    const authUser = await requireAuthUser(req);
    if (authUser.role !== 'student') {
      return res.status(403).json({ error: 'Forbidden: Only students can access this' });
    }

    req.user = authUser;
    next();
  } catch (error) {
    return res.status(error.statusCode || 401).json({ error: error.message || 'Unauthorized' });
  }
};

// GET all enrolled courses for the student
router.get('/courses', isStudent, async (req, res) => {
  try {
    const enrollments = await Enrollment.find({ userId: req.user.userId })
      .sort({ enrolledAt: -1 })
      .lean();

    const coursesWithProgress = await Promise.all(
      enrollments.map(async (enrollment) => {
        const progress = await Progress.findOne({
          userId: req.user.userId,
          courseId: enrollment.courseId,
        }).lean();

        const course = await Course.findById(enrollment.courseId)
          .populate('categoryId', 'name')
          .populate('instructorId', 'firstName lastName')
          .lean();

        return {
          enrollment: {
            _id: enrollment._id,
            enrolledAt: enrollment.enrolledAt,
            status: enrollment.status,
            completedAt: enrollment.completedAt,
          },
          course: {
            _id: course?._id,
            title: course?.title,
            description: course?.description,
            thumbnail: course?.thumbnail,
            price: course?.price,
            category: course?.categoryId,
            instructor: course?.instructorId,
          },
          progress: progress ? {
            overallProgress: progress.overallProgress,
            completedSections: progress.completedSections?.length || 0,
            completedQuizzes: progress.completedQuizzes?.length || 0,
            completedFinalExam: progress.completedFinalExam || false,
            lastAccessedAt: progress.lastAccessedAt,
          } : null,
        };
      })
    );

    res.json({ courses: coursesWithProgress });
  } catch (error) {
    console.error('Error fetching enrolled courses:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET statistics for the student
router.get('/statistics', isStudent, async (req, res) => {
  try {
    const userId = req.user.userId;

    const totalEnrollments = await Enrollment.countDocuments({ userId });
    
    const activeEnrollments = await Enrollment.countDocuments({ 
      userId,
      status: 'active' 
    });

    const completedCourses = await Enrollment.countDocuments({ 
      userId,
      status: 'completed' 
    });

    const allProgress = await Progress.find({ userId }).lean();
    const averageProgress = allProgress.length > 0
      ? Math.round(
          allProgress.reduce((sum, p) => sum + (p.overallProgress || 0), 0) / allProgress.length
        )
      : 0;

    const coursesInProgress = await Progress.countDocuments({
      userId,
      overallProgress: { $gt: 0, $lt: 100 },
    });

    res.json({
      statistics: {
        totalEnrollments,
        activeEnrollments,
        completedCourses,
        coursesInProgress,
        averageProgress,
      },
    });
  } catch (error) {
    console.error('Error fetching student statistics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET progress for a student
router.get('/progress', isStudent, async (req, res) => {
  try {
    const { courseId } = req.query;

    if (courseId) {
      const progress = await Progress.findOne({
        userId: req.user.userId,
        courseId,
      }).lean();

      if (!progress) {
        return res.status(404).json({ error: 'Progress not found' });
      }

      const course = await Course.findById(courseId)
        .populate('categoryId', 'name')
        .populate('instructorId', 'firstName lastName')
        .lean();

      const modulesData = await Module.find({ courseId }).sort({ order: 1 }).lean();

      const modulesWithProgress = await Promise.all(
        modulesData.map(async (module) => {
          const sections = await Section.find({ moduleId: module._id }).sort({ order: 1 }).lean();
          let quiz = null;
          if (module.quiz) {
            quiz = await Quiz.findById(module.quiz).lean();
          }

          const sectionsWithProgress = await Promise.all(
            sections.map(async (section) => {
              if (section.type === 'quiz' && section.quizId) {
                const sectionQuiz = await loadQuizWithQuestions(section.quizId);
                return {
                  ...section,
                  quiz: sectionQuiz,
                  completed: progress.completedQuizzes?.some(
                    (id) => id.toString() === section.quizId.toString()
                  ) || false,
                };
              }

              return {
                ...section,
                completed: progress.completedSections?.some((id) => id.toString() === section._id.toString()) || false,
              };
            })
          );

          return {
            ...module,
            sections: sectionsWithProgress,
            quiz: quiz ? {
              ...quiz,
              completed: progress.completedQuizzes?.some((id) => id.toString() === quiz._id.toString()) || false,
            } : null,
          };
        })
      );

      res.json({
        progress: {
          overallProgress: progress.overallProgress,
          completedSections: progress.completedSections,
          completedQuizzes: progress.completedQuizzes,
          completedFinalExam: progress.completedFinalExam,
          lastAccessedAt: progress.lastAccessedAt,
          moduleId: progress.moduleId,
          sectionId: progress.sectionId,
          quizId: progress.quizId,
        },
        course,
        modules: modulesWithProgress,
      });
    } else {
      const allProgress = await Progress.find({ userId: req.user.userId })
        .populate('courseId', 'title thumbnail')
        .sort({ lastAccessedAt: -1 })
        .lean();
      res.json({ progress: allProgress });
    }
  } catch (error) {
    console.error('Error fetching progress:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET course training content (sections, quizzes, final exam in order)
router.get('/courses/:courseId/training', async (req, res) => {
  try {
    const { courseId } = req.params;

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Please log in with a student account to access this course' });
    }

    let userId = null;
    try {
      const authUser = await requireAuthUser(req);
      if (authUser.role !== 'student') {
        return res.status(403).json({ error: 'Forbidden: Only students can access this course' });
      }
      userId = authUser.userId;
    } catch (e) {
      return res.status(401).json({ error: 'Please log in with a student account to access this course' });
    }

    // Get course to check if it's free
    let course = await Course.findById(courseId).lean();
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const isFree = !course.price || course.price === 0;
    const enrollment = await Enrollment.findOne({
      userId,
      courseId,
    }).lean();

    if (course.status !== 'published') {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Paid courses and closed courses require an existing enrollment.
    if ((!isFree || course.enrollmentOpen === false) && !enrollment) {
      return res.status(403).json({ error: 'Not enrolled in this course' });
    }

    // Get course with full populate
    course = await Course.findById(courseId)
      .populate('categoryId', 'name')
      .populate('instructorId', 'firstName lastName')
      .populate({
        path: 'finalExam',
        populate: {
          path: 'questions',
          populate: {
            path: 'answers'
          },
          options: { sort: { order: 1 } }
        }
      })
      .lean();

    // Get progress (only if user is logged in)
    let progress = null;
    if (userId) {
      progress = await Progress.findOne({
        userId,
        courseId,
      }).lean();
    }

    // Get modules with populate
    const modulesData = await Module.find({ courseId })
      .sort({ order: 1 })
      .populate({
        path: 'quiz',
        populate: {
          path: 'questions',
          populate: {
            path: 'answers'
          },
          options: { sort: { order: 1 } }
        }
      })
      .lean();

    // Build training content in order
    const trainingContent = [];

    // Process each module
    for (const module of modulesData) {
      // Add sections
      const sections = await Section.find({ moduleId: module._id })
        .sort({ order: 1 })
        .lean();

      for (const section of sections) {
        if (section.type === 'quiz' && section.quizId) {
          const sectionQuiz = await loadQuizWithQuestions(section.quizId);
          if (sectionQuiz) {
            trainingContent.push({
              type: 'quiz',
              _id: sectionQuiz._id,
              title: section.title || sectionQuiz.title || 'Quiz',
              moduleId: module._id,
              moduleTitle: module.title,
              order: section.order,
              completed: progress?.completedQuizzes?.some(
                (id) => id.toString() === sectionQuiz._id.toString()
              ) || false,
              isFinalExam: false,
              sectionId: section._id,
              data: sectionQuiz,
            });
            continue;
          }
        }

        trainingContent.push({
          type: 'section',
          _id: section._id,
          title: section.title,
          moduleId: module._id,
          moduleTitle: module.title,
          order: section.order,
          completed: progress?.completedSections?.some(
            (id) => id.toString() === section._id.toString()
          ) || false,
          data: section
        });
      }

      // Add module quiz after sections
      if (module.quiz) {
        const quiz = typeof module.quiz === 'object' ? module.quiz : await Quiz.findById(module.quiz)
          .populate({
            path: 'questions',
            populate: {
              path: 'answers'
            },
            options: { sort: { order: 1 } }
          })
          .lean();

        if (quiz) {
          trainingContent.push({
            type: 'quiz',
            _id: quiz._id,
            title: quiz.title || 'Module Quiz',
            moduleId: module._id,
            moduleTitle: module.title,
            order: module.order + 1000, // Place after sections
            completed: progress?.completedQuizzes?.some(
              (id) => id.toString() === quiz._id.toString()
            ) || false,
            isFinalExam: false,
            data: quiz
          });
        }
      }
    }

    // Add final exam at the end
    if (course.finalExam) {
      const finalExam = typeof course.finalExam === 'object' 
        ? course.finalExam 
        : await Quiz.findById(course.finalExam)
            .populate({
              path: 'questions',
              populate: {
                path: 'answers'
              },
              options: { sort: { order: 1 } }
            })
            .lean();

      if (finalExam) {
        trainingContent.push({
          type: 'finalExam',
          _id: finalExam._id,
          title: finalExam.title || 'Final Exam',
          order: 9999, // Always last
          completed: progress?.completedFinalExam || false,
          isFinalExam: true,
          data: finalExam
        });
      }
    }

    res.json({
      course: {
        _id: course._id,
        title: course.title,
        description: course.description,
        thumbnail: course.thumbnail,
        instructor: course.instructorId,
        category: course.categoryId
      },
      trainingContent,
      progress: progress ? {
        overallProgress: progress.overallProgress,
        lastAccessedAt: progress.lastAccessedAt
      } : null
    });
  } catch (error) {
    console.error('Error fetching training content:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update progress
router.put('/progress', isStudent, async (req, res) => {
  try {
    const { courseId, moduleId, sectionId, quizId, completedFinalExam } = req.body;

    if (!courseId) {
      return res.status(400).json({ error: 'Course ID is required' });
    }

    let progress = await Progress.findOne({
      userId: req.user.userId,
      courseId,
    });

    if (!progress) {
      const enrollment = await Enrollment.findOne({
        userId: req.user.userId,
        courseId,
      });

      if (!enrollment) {
        return res.status(400).json({ error: 'Not enrolled in this course' });
      }

      progress = new Progress({
        userId: req.user.userId,
        courseId,
        enrollmentId: enrollment._id,
        completedSections: [],
        completedQuizzes: [],
        completedFinalExam: false,
        overallProgress: 0,
      });
    }

    if (moduleId) progress.moduleId = moduleId;
    if (sectionId) {
      progress.sectionId = sectionId;
      progress.quizId = undefined;
      if (!progress.completedSections.some((id) => String(id) === String(sectionId))) {
        progress.completedSections.push(sectionId);
      }
    }
    if (quizId) {
      const passedAttempt = await QuizAttempt.exists({
        userId: req.user.userId,
        courseId,
        quizId,
        passed: true,
      });

      if (!passedAttempt) {
        return res.status(403).json({ error: 'Quiz must be passed before it can be marked complete.' });
      }

      progress.quizId = quizId;
      progress.sectionId = undefined;
      if (!progress.completedQuizzes.some((id) => String(id) === String(quizId))) {
        progress.completedQuizzes.push(quizId);
      }
    }

    if (completedFinalExam !== undefined) {
      if (completedFinalExam) {
        const course = await Course.findById(courseId).select('finalExam').lean();
        const finalExamId = course?.finalExam;
        const passedAttempt = finalExamId
          ? await QuizAttempt.exists({
            userId: req.user.userId,
            courseId,
            quizId: finalExamId,
            passed: true,
          })
          : null;

        if (!passedAttempt) {
          return res.status(403).json({ error: 'Final exam must be passed before it can be marked complete.' });
        }
      }

      progress.completedFinalExam = completedFinalExam;
      if (completedFinalExam) progress.quizId = undefined;
    }

    await recalculateProgress(progress, courseId);

    res.json({ message: 'Progress updated successfully', progress });
  } catch (error) {
    console.error('Error updating progress:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update student profile
router.put('/profile', isStudent, async (req, res) => {
  try {
    const { firstName, lastName, email, phone, bio, profileImage } = req.body;
    
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update fields
    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (email) user.email = email;
    if (phone !== undefined) user.phone = phone;
    if (bio !== undefined) user.bio = bio;
    if (profileImage !== undefined) user.profileImage = profileImage;

    await user.save();

    // Return updated user
    res.json({
      user: {
        id: user._id.toString(),
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        phone: user.phone,
        bio: user.bio,
        profileImage: user.profileImage,
      }
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST enroll in a course
router.post('/enroll', isStudent, async (req, res) => {
  try {
    const { courseId } = req.body;
    const userId = req.user.userId;

    if (!courseId) {
      return res.status(400).json({ error: 'Course ID is required' });
    }

    // Check if course exists
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Check if already enrolled
    const existingEnrollment = await Enrollment.findOne({ userId, courseId });
    if (existingEnrollment) {
      return res.status(400).json({ error: 'Already enrolled in this course' });
    }

    if (course.status !== 'published' || course.enrollmentOpen === false) {
      return res.status(404).json({ error: 'Course not available for enrollment' });
    }

    if (course.price && course.price > 0) {
      return res.status(402).json({
        error: 'Payment required for this course',
        requiresPurchase: true,
        courseId,
        redirectTo: `/courses/${courseId}`,
      });
    }

    const { enrollment } = await ensureEnrollmentAndProgress({
      userId,
      courseId,
    });

    res.status(201).json({ message: 'Enrolled successfully', enrollment });
  } catch (error) {
    console.error('Error enrolling in course:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST change password
router.post('/change-password', isStudent, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update notification settings
router.put('/notifications', isStudent, async (req, res) => {
  try {
    const { emailNotifications, courseUpdates, studentMessages, marketingEmails } = req.body;
    
    // For now, just return success (notification settings can be stored in user model if needed)
    res.json({ 
      message: 'Notification settings updated successfully',
      settings: {
        emailNotifications: emailNotifications !== undefined ? emailNotifications : true,
        courseUpdates: courseUpdates !== undefined ? courseUpdates : true,
        studentMessages: studentMessages !== undefined ? studentMessages : true,
        marketingEmails: marketingEmails !== undefined ? marketingEmails : false,
      }
    });
  } catch (error) {
    console.error('Error updating notification settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST upload file
router.post('/upload', isStudent, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const response = getUploadErrorResponse(err, '5MB');
      return res.status(response.status).json(response.body);
    }
    next();
  });
}, async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const metadata = validateUploadedFile(file, { allowedExtensions: IMAGE_EXTENSIONS });
    
    const fileId = await uploadFileToGridFS(file.buffer, metadata.storageName, {
      originalName: metadata.originalName,
      uploadedBy: req.user.userId,
      uploadedAt: new Date(),
      contentType: metadata.contentType,
      size: metadata.size,
      extension: metadata.extension,
      category: metadata.category,
    });

    const fileUrl = `/api/files/${fileId}`;
    
    res.status(200).json({ 
      fileId,
      fileUrl,
      fileName: metadata.originalName,
      fileSize: metadata.size,
      fileType: metadata.contentType
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    const response = getUploadErrorResponse(error, '5MB');
    res.status(response.status).json(response.body);
  }
});

// GET certificates for the student
router.get('/certificates', isStudent, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get all certificates for this student
    const certificates = await Certificate.find({ studentId: userId })
      .populate('courseId', 'title thumbnail categoryId')
      .sort({ issuedAt: -1 })
      .lean();

    // Populate category for each course
    const certificatesWithDetails = await Promise.all(
      certificates.map(async (cert) => {
        let category = null;
        if (cert.courseId && cert.courseId.categoryId) {
          category = await Category.findById(cert.courseId.categoryId).select('name').lean();
        }

        return {
          _id: cert._id,
          course: {
            _id: cert.courseId?._id,
            title: cert.courseId?.title || cert.courseName,
            thumbnail: cert.courseId?.thumbnail,
            category: category,
          },
          student: {
            firstName: cert.studentName?.split(' ')[0] || '',
            lastName: cert.studentName?.split(' ').slice(1).join(' ') || '',
          },
          completionDate: cert.completionDate,
          certificateNumber: cert.certificateId,
        };
      })
    );

    res.json({ certificates: certificatesWithDetails });
  } catch (error) {
    console.error('Error fetching certificates:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET a specific section (for enrolled students)
router.get('/sections/:sectionId', isStudent, async (req, res) => {
  try {
    const { sectionId } = req.params;
    const userId = req.user.userId;

    // Find the section
    const section = await Section.findById(sectionId).lean();
    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }

    // Find the module to get courseId
    const module = await Module.findById(section.moduleId).lean();
    if (!module) {
      return res.status(404).json({ error: 'Module not found' });
    }

    // Check if student is enrolled in the course
    const enrollment = await Enrollment.findOne({ 
      userId, 
      courseId: module.courseId 
    }).lean();

    if (!enrollment) {
      return res.status(403).json({ error: 'Not enrolled in this course' });
    }

    // Return the section with courseId included
    res.json({
      ...section,
      courseId: module.courseId,
    });
  } catch (error) {
    console.error('Error fetching section:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST create/generate certificate for completed course
router.post('/certificates', isStudent, async (req, res) => {
  try {
    const { courseId } = req.body;
    const userId = req.user.userId;

    if (!courseId) {
      return res.status(400).json({ error: 'Course ID is required' });
    }

    // Check if course exists
    const course = await Course.findById(courseId)
      .populate('instructorId', 'firstName lastName')
      .lean();
    
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Check if enrolled and completed
    const enrollment = await Enrollment.findOne({ userId, courseId }).lean();
    if (!enrollment) {
      return res.status(403).json({ error: 'Not enrolled in this course' });
    }

    // Check progress
    const progress = await Progress.findOne({ userId, courseId }).lean();
    if (!progress || progress.overallProgress < 100) {
      return res.status(400).json({ error: 'Course not completed yet' });
    }

    // Get user info
    const user = await User.findById(userId).select('firstName lastName').lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if certificate already exists
    let certificate = await Certificate.findOne({ studentId: userId, courseId }).lean();
    
    if (certificate) {
      // Certificate already exists, return it
      return res.json({
        message: 'Certificate already exists',
        certificate: {
          _id: certificate._id,
          certificateId: certificate.certificateId,
        },
        shareUrl: `/certificates/${certificate._id}`,
      });
    }

    // Generate unique certificate ID
    const certificateId = `CERT-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    // Create certificate
    certificate = await Certificate.create({
      studentId: userId,
      courseId,
      certificateId,
      studentName: `${user.firstName} ${user.lastName}`,
      courseName: course.title,
      instructorName: course.instructorId 
        ? `${course.instructorId.firstName} ${course.instructorId.lastName}`
        : 'Unknown',
      score: progress.overallProgress,
      completionDate: enrollment.completedAt || new Date(),
      issuedAt: new Date(),
    });

    res.status(201).json({
      message: 'Certificate generated successfully',
      certificate: {
        _id: certificate._id,
        certificateId: certificate.certificateId,
      },
      shareUrl: `/certificates/${certificate._id}`,
    });
  } catch (error) {
    console.error('Error generating certificate:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET a specific quiz with questions (for enrolled students)
router.get('/quizzes/:quizId', isStudent, async (req, res) => {
  try {
    const { quizId } = req.params;
    const userId = req.user.userId;

    // Find the quiz and populate questions with their answers
    const quiz = await Quiz.findById(quizId)
      .populate({
        path: 'questions',
        populate: { path: 'answers' }
      })
      .lean();
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    // Find which course this quiz belongs to (either module quiz or final exam)
    let courseId = null;
    
    // Check if it's a final exam
    const courseByFinalExam = await Course.findOne({ finalExam: quizId }).lean();
    if (courseByFinalExam) {
      courseId = courseByFinalExam._id;
    } else {
      // Check if it's a module quiz
      const module = await Module.findOne({ quiz: quizId }).lean();
      if (module) {
        courseId = module.courseId;
      } else {
        const section = await Section.findOne({ quizId }).lean();
        if (section) {
          const sectionModule = await Module.findById(section.moduleId).lean();
          courseId = sectionModule?.courseId || null;
        }
      }
    }

    // If we found a courseId, check if student is enrolled
    if (courseId) {
      const enrollment = await Enrollment.findOne({ 
        userId, 
        courseId 
      }).lean();

      if (!enrollment) {
        return res.status(403).json({ error: 'Not enrolled in this course' });
      }
    }

    // Return the quiz with courseId
    res.json({
      ...quiz,
      courseId: courseId,
    });
  } catch (error) {
    console.error('Error fetching quiz:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST submit a quiz attempt and score it server-side
router.post('/quizzes/:quizId/attempts', isStudent, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { answers = [] } = req.body || {};
    const userId = req.user.userId;
    const context = await getQuizCourseContext(quizId);

    if (!context?.quiz || !context.courseId) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const enrollment = await Enrollment.findOne({
      userId,
      courseId: context.courseId,
    });

    if (!enrollment) {
      return res.status(403).json({ error: 'Not enrolled in this course' });
    }

    if (!Array.isArray(answers)) {
      return res.status(400).json({ error: 'Answers must be an array.' });
    }

    const submittedByQuestionId = new Map(
      answers.map((answer) => [String(answer?.questionId || ''), answer || {}])
    );
    const scoredAnswers = [];
    let pointsAwarded = 0;
    let pointsPossible = 0;

    for (const question of context.quiz.questions || []) {
      const questionId = String(question._id);
      const submittedAnswer = submittedByQuestionId.get(questionId) || {};
      const submittedAnswerIds = Array.isArray(submittedAnswer.answerIds)
        ? submittedAnswer.answerIds.map((answerId) => String(answerId))
        : submittedAnswer.answerId
          ? [String(submittedAnswer.answerId)]
          : [];
      const submittedSet = idSet(submittedAnswerIds);
      const correctAnswerIds = (question.answers || [])
        .filter((answer) => answer.isCorrect)
        .map((answer) => String(answer._id));
      const correctSet = idSet(correctAnswerIds);
      const possible = Number(question.points || 1);
      let correct = false;

      if (question.type === 'multiple_correct') {
        correct =
          submittedSet.size === correctSet.size &&
          [...correctSet].every((answerId) => submittedSet.has(answerId));
      } else if (
        question.type === 'qcm' ||
        question.type === 'single_choice' ||
        question.type === 'true_false' ||
        question.type === 'quiz_image'
      ) {
        correct = submittedSet.size === 1 && correctSet.has([...submittedSet][0]);
      } else if (question.type === 'sequence' || question.type === 'drag_drop' || question.type === 'matching') {
        const expectedOrder = [...(question.answers || [])]
          .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
          .map((answer) => String(answer._id));
        correct =
          submittedAnswerIds.length === expectedOrder.length &&
          expectedOrder.every((answerId, index) => submittedAnswerIds[index] === answerId);
      } else if (question.type === 'fill_blank') {
        const submittedText = String(submittedAnswer.textAnswer || '').trim().toLowerCase();
        correct = (question.answers || []).some(
          (answer) => answer.isCorrect && String(answer.answer || '').trim().toLowerCase() === submittedText
        );
      }

      const awarded = correct ? possible : 0;
      pointsPossible += possible;
      pointsAwarded += awarded;
      scoredAnswers.push({
        questionId: question._id,
        answerIds: submittedAnswerIds,
        textAnswer:
          typeof submittedAnswer.textAnswer === 'string' ? submittedAnswer.textAnswer : undefined,
        correct,
        pointsAwarded: awarded,
        pointsPossible: possible,
      });
    }

    const score =
      pointsPossible > 0 ? Math.round((pointsAwarded / pointsPossible) * 100) : 0;
    const passed = score >= Number(context.quiz.passingScore || 60);

    const attempt = await QuizAttempt.create({
      userId,
      quizId,
      courseId: context.courseId,
      moduleId: context.moduleId || undefined,
      isFinalExam: context.isFinalExam,
      answers: scoredAnswers,
      score,
      pointsAwarded,
      pointsPossible,
      passed,
    });

    let progress = await Progress.findOne({
      userId,
      courseId: context.courseId,
    });

    if (!progress) {
      progress = new Progress({
        userId,
        courseId: context.courseId,
        enrollmentId: enrollment._id,
        completedSections: [],
        completedQuizzes: [],
        completedFinalExam: false,
        overallProgress: 0,
      });
    }

    if (passed) {
      if (context.isFinalExam) {
        progress.completedFinalExam = true;
        progress.quizId = undefined;
      } else {
        progress.quizId = quizId;
        progress.sectionId = undefined;
        if (!progress.completedQuizzes.some((id) => String(id) === String(quizId))) {
          progress.completedQuizzes.push(quizId);
        }
      }
    }

    await recalculateProgress(progress, context.courseId);

    return res.json({
      attempt: {
        _id: attempt._id,
        score,
        passed,
        pointsAwarded,
        pointsPossible,
      },
      progress,
    });
  } catch (error) {
    console.error('Error submitting quiz attempt:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
