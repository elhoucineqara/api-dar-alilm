const Category = require('../models/Category');

const DEFAULT_CATEGORY_DEFINITIONS = [
  {
    name: 'Web Developpment',
    slug: 'web-developpment',
    icon: 'globe',
    order: 1,
    description: 'Frontend, backend, and full-stack web application building.',
    aliases: ['web development'],
  },
  {
    name: 'Networking',
    slug: 'networking',
    icon: 'network',
    order: 2,
    description: 'Network fundamentals, infrastructure, routing, and connectivity.',
  },
  {
    name: 'Operating System',
    slug: 'operating-system',
    icon: 'server',
    order: 3,
    description: 'System administration, shells, services, and platform internals.',
  },
  {
    name: 'Cybersecurity',
    slug: 'cybersecurity',
    icon: 'shield',
    order: 4,
    description: 'Security basics, hardening, auditing, and defensive practices.',
  },
  {
    name: 'Programming',
    slug: 'programming',
    icon: 'code',
    order: 5,
    description: 'Core programming concepts, algorithms, and software craftsmanship.',
    aliases: ['programmation'],
  },
];

const SUPPORTED_CATEGORY_ICONS = new Set([
  'globe',
  'network',
  'server',
  'shield',
  'code',
  'grid',
]);

function getApprovedCategoryQuery() {
  return {
    $or: [{ approvalStatus: 'approved' }, { approvalStatus: { $exists: false } }],
  };
}

function normalizeCategoryLabel(value = '') {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function slugifyCategoryName(name = '') {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function isSupportedCategoryIcon(icon) {
  return SUPPORTED_CATEGORY_ICONS.has(String(icon || '').trim());
}

function sortCategories(categories = []) {
  return [...categories].sort((left, right) => {
    const leftOrder = Number.isFinite(left?.order) ? left.order : 999;
    const rightOrder = Number.isFinite(right?.order) ? right.order : 999;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return String(left?.name || '').localeCompare(String(right?.name || ''), 'en', {
      sensitivity: 'base',
    });
  });
}

function categoryMatchesDefinition(category, definition) {
  const categorySlug = category?.slug || slugifyCategoryName(category?.name);
  const categoryName = normalizeCategoryLabel(category?.name);
  const definitionAliases = [
    normalizeCategoryLabel(definition.name),
    ...(definition.aliases || []).map(normalizeCategoryLabel),
  ];

  return categorySlug === definition.slug || definitionAliases.includes(categoryName);
}

function getDefaultCategoryDefinition(identifier) {
  const normalized = normalizeCategoryLabel(identifier);
  const slug = slugifyCategoryName(identifier);

  return (
    DEFAULT_CATEGORY_DEFINITIONS.find((definition) => {
      if (definition.slug === slug) {
        return true;
      }

      const aliases = [
        normalizeCategoryLabel(definition.name),
        ...(definition.aliases || []).map(normalizeCategoryLabel),
      ];

      return aliases.includes(normalized);
    }) || null
  );
}

async function ensureDefaultCategories({ adminUserId } = {}) {
  const categories = await Category.find(getApprovedCategoryQuery()).lean();
  const unmatchedCategories = [...categories];

  for (const definition of DEFAULT_CATEGORY_DEFINITIONS) {
    const matchIndex = unmatchedCategories.findIndex((category) =>
      categoryMatchesDefinition(category, definition)
    );
    const matchedCategory = matchIndex >= 0 ? unmatchedCategories.splice(matchIndex, 1)[0] : null;
    const payload = {
      name: definition.name,
      description: definition.description,
      slug: definition.slug,
      icon: definition.icon,
      order: definition.order,
      isDefault: true,
      approvalStatus: 'approved',
    };

    if (adminUserId) {
      payload.createdBy = adminUserId;
    }

    if (matchedCategory) {
      await Category.updateOne(
        { _id: matchedCategory._id },
        {
          $set: payload,
          $unset: {
            instructorId: '',
          },
        }
      );
    } else {
      await Category.create(payload);
    }
  }

  return sortCategories(await Category.find(getApprovedCategoryQuery()).lean());
}

module.exports = {
  DEFAULT_CATEGORY_DEFINITIONS,
  SUPPORTED_CATEGORY_ICONS,
  ensureDefaultCategories,
  getApprovedCategoryQuery,
  getDefaultCategoryDefinition,
  isSupportedCategoryIcon,
  normalizeCategoryLabel,
  slugifyCategoryName,
  sortCategories,
};
