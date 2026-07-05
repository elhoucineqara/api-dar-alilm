require('dotenv').config();

const connectDB = require('../lib/db');
const { isReservedAdminEmail } = require('../lib/auth-user');
const { ensureDefaultCategories, getDefaultCategoryDefinition } = require('../lib/category-catalog');

const Answer = require('../models/Answer');
const Category = require('../models/Category');
const Certificate = require('../models/Certificate');
const Course = require('../models/Course');
const CoursePayment = require('../models/CoursePayment');
const Enrollment = require('../models/Enrollment');
const ForumPost = require('../models/ForumPost');
const Module = require('../models/Module');
const Progress = require('../models/Progress');
const Question = require('../models/Question');
const Quiz = require('../models/Quiz');
const Section = require('../models/Section');
const User = require('../models/User');

function uniqueObjectIds(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

async function main() {
  await connectDB();

  const allUsers = await User.find({}).select('_id email role').lean();
  const preservedAdmins = allUsers.filter((user) => isReservedAdminEmail(user.email));
  const usersToDelete = allUsers.filter((user) => !isReservedAdminEmail(user.email));

  const preservedAdminIds = uniqueObjectIds(preservedAdmins.map((user) => user._id));
  const userIdsToDelete = uniqueObjectIds(usersToDelete.map((user) => user._id));

  const keptCourses = await Course.find({
    instructorId: { $in: preservedAdminIds },
  })
    .populate('categoryId', 'name slug')
    .select('_id title categoryId')
    .lean();

  const coursesToDelete = await Course.find({
    instructorId: { $in: userIdsToDelete },
  })
    .select('_id finalExam')
    .lean();

  const courseIdsToDelete = uniqueObjectIds(coursesToDelete.map((course) => course._id));

  const modulesToDelete = await Module.find({
    courseId: { $in: courseIdsToDelete },
  })
    .select('_id quiz')
    .lean();

  const moduleIdsToDelete = uniqueObjectIds(modulesToDelete.map((module) => module._id));
  const quizIdsToDelete = uniqueObjectIds([
    ...modulesToDelete.map((module) => module.quiz),
    ...coursesToDelete.map((course) => course.finalExam),
  ]);

  const questionsToDelete = await Question.find({
    quizId: { $in: quizIdsToDelete },
  })
    .select('_id')
    .lean();

  const questionIdsToDelete = uniqueObjectIds(questionsToDelete.map((question) => question._id));

  await Promise.all([
    Answer.deleteMany({ questionId: { $in: questionIdsToDelete } }),
    Question.deleteMany({ _id: { $in: questionIdsToDelete } }),
    Quiz.deleteMany({ _id: { $in: quizIdsToDelete } }),
    Section.deleteMany({ moduleId: { $in: moduleIdsToDelete } }),
    Module.deleteMany({ _id: { $in: moduleIdsToDelete } }),
    Enrollment.deleteMany({
      $or: [{ userId: { $in: userIdsToDelete } }, { courseId: { $in: courseIdsToDelete } }],
    }),
    Progress.deleteMany({
      $or: [{ userId: { $in: userIdsToDelete } }, { courseId: { $in: courseIdsToDelete } }],
    }),
    Certificate.deleteMany({
      $or: [{ studentId: { $in: userIdsToDelete } }, { courseId: { $in: courseIdsToDelete } }],
    }),
    CoursePayment.deleteMany({
      $or: [
        { userId: { $in: userIdsToDelete } },
        { instructorId: { $in: userIdsToDelete } },
        { courseId: { $in: courseIdsToDelete } },
      ],
    }),
    ForumPost.deleteMany({
      $or: [{ authorId: { $in: userIdsToDelete } }, { courseId: { $in: courseIdsToDelete } }],
    }),
    ForumPost.updateMany(
      { 'replies.authorId': { $in: userIdsToDelete } },
      {
        $pull: {
          replies: {
            authorId: { $in: userIdsToDelete },
          },
        },
      }
    ),
    ForumPost.updateMany(
      { likes: { $in: userIdsToDelete } },
      {
        $pull: {
          likes: { $in: userIdsToDelete },
        },
      }
    ),
    Course.deleteMany({ _id: { $in: courseIdsToDelete } }),
    User.deleteMany({ _id: { $in: userIdsToDelete } }),
    Category.deleteMany({}),
  ]);

  const categories = await ensureDefaultCategories({
    adminUserId: preservedAdminIds[0] || null,
  });
  const categoryIdBySlug = new Map(
    categories.map((category) => [String(category.slug), category._id])
  );

  for (const course of keptCourses) {
    const categoryName = course.categoryId?.name || '';
    const defaultDefinition =
      getDefaultCategoryDefinition(categoryName) || getDefaultCategoryDefinition('Programming');
    const nextCategoryId = categoryIdBySlug.get(defaultDefinition.slug);

    if (nextCategoryId) {
      await Course.updateOne(
        { _id: course._id },
        {
          $set: {
            categoryId: nextCategoryId,
          },
        }
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        preservedAdmins: preservedAdmins.length,
        deletedUsers: usersToDelete.length,
        deletedCourses: coursesToDelete.length,
        recreatedCategories: categories.map((category) => ({
          name: category.name,
          icon: category.icon,
        })),
      },
      null,
      2
    )
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
