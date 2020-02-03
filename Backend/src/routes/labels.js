var express = require('express');
var router = express.Router();
var cors = require('cors');
var Raven = require('raven');

// DB
var SQ = require('../models').sequelize;
var User = require('../models').User;
var Recipe = require('../models').Recipe;
var Label = require('../models').Label;
var Recipe_Label = require('../models').Recipe_Label;

// Services
var MiddlewareService = require('../services/middleware');

//Add a label to a recipeId or recipeIds
router.post(
  '/',
  cors(),
  MiddlewareService.validateSession(['user']),
  function(req, res, next) {

  if (!req.body.title || req.body.title.length === 0) {
    var e = new Error("Label title must be provided.");
    e.status = 412;
    return next(e);
  }

  if ((!req.body.recipeId || req.body.recipeId.length === 0) && (!req.body.recipeIds || req.body.recipeIds.length === 0)) {
    var e = new Error("RecipeId or recipeIds must be provided.");
    e.status = 412;
    return next(e);
  }

  let recipeIds = req.body.recipeId ? [req.body.recipeId] : req.body.recipeIds;

  SQ.transaction(t => {
    return Label.findOrCreate({
      where: {
        userId: res.locals.session.userId,
        title: req.body.title.toLowerCase().replace(',', '')
      },
      transaction: t
    }).then(([label]) => {
      return Recipe_Label.bulkCreate(recipeIds.map(recipeId => ({
        recipeId,
        labelId: label.id
      })), {
        transaction: t
      }).then(() => {
        return label
      });
    });
  }).then(label => {
    res.status(201).send(label);
  }).catch(next);
});

//Get all of a user's labels
router.get(
  '/',
  cors(),
  MiddlewareService.validateSession(['user']),
  function(req, res, next) {

  Label.findAll({
    where: {
      userId: res.locals.session.userId
    },
    include: [{
      model: Recipe_Label,
      as: 'recipe_labels',
      attributes: [],
    }],
    attributes: ['id', 'title', 'createdAt', 'updatedAt', [SQ.fn('COUNT', SQ.col('recipe_labels.id')), 'recipeCount']],
    group: ['Label.id'],
    order: [
      ['title', 'ASC']
    ]
  })
  .then(function(labels) {
    labels = labels.map(label => { label = label.toJSON(); label.recipes = []; return label; })
    res.status(200).json(labels);
  })
  .catch(next);
});

//Delete a label from a recipe
router.delete(
  '/',
  cors(),
  MiddlewareService.validateSession(['user']),
  async (req, res, next) => {

  if (!req.query.recipeId || !req.query.labelId) {
    return res.status(412).json({
      msg: "RecipeId and LabelId are required!"
    });
  }

  try {
    await SQ.transaction(async transaction => {
      const label = await Label.findOne({
        where: {
          id: req.query.labelId,
          userId: res.locals.session.userId
        },
        include: [{
          model: Recipe,
          as: 'recipes',
          attributes: ['id']
        }],
        transaction
      });

      if (!label || !label.recipes.some(r => r.id == req.query.recipeId)) {
        const e = new Error("Label does not exist!");
        e.status = 404;
        throw e;
      }

      await label.removeRecipe(req.query.recipeId, {
        transaction
      })

      if (label.recipes.length === 1) {
        await label.destroy({transaction});

        return {}; // Label was deleted;
      } else {
        return label;
      }
    }).then(label => {
      res.status(200).json(label);
    });
  } catch(e) {
    next(e);
  }
});

module.exports = router;