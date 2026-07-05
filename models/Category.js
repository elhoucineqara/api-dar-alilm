const mongoose = require('mongoose');

function slugifyCategoryName(name = '') {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const CategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    slug: {
      type: String,
      trim: true,
      lowercase: true,
    },
    icon: {
      type: String,
      trim: true,
      default: 'grid',
    },
    order: {
      type: Number,
      default: 999,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    approvalStatus: {
      type: String,
      enum: ['approved', 'pending'],
      default: 'approved',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    approvedAt: {
      type: Date,
    },
    instructorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

CategorySchema.pre('validate', function setCategorySlug(next) {
  if (this.name && (!this.slug || this.isModified('name'))) {
    this.slug = slugifyCategoryName(this.name);
  }

  next();
});

CategorySchema.index({ slug: 1 }, { unique: true, sparse: true });

const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);

module.exports = Category;
