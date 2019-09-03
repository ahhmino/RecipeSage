let fs = require('fs-extra');
let mdb = require('mdb');
let extract = require('extract-zip');
let sqlite3 = require('sqlite3');
const performance = require('perf_hooks').performance;
var Raven = require('raven');
const { exec, spawn } = require('child_process');

var Op = require("sequelize").Op;
var SQ = require('./models').sequelize;
var User = require('./models').User;
var Recipe = require('./models').Recipe;
var FCMToken = require('./models').FCMToken;
var Label = require('./models').Label;
var Recipe_Label = require('./models').Recipe_Label;

var UtilService = require('./services/util');

let runConfig = {
  path: process.argv[2],
  userId: process.argv[3],
  includeStockRecipes: process.argv.indexOf('--includeStockRecipes') > -1,
  excludeImages: process.argv.indexOf('--excludeImages') > -1,
  includeTechniques: process.argv.indexOf('--includeTechniques') > -1
}

var testMode = process.env.NODE_ENV === 'test';

if (fs.existsSync("./config/config.json")) {
  if (!testMode) console.log("config.json found");
} else {
  var content = fs.readFileSync('./config/config-template.json');
  fs.writeFileSync('./config/config.json', content);
  if (!testMode) console.log("config.json initialized");
}
var appConfig = require('./config/config.json');
var devMode = appConfig.environment === 'dev';

Raven.config(appConfig.sentry.dsn, {
  environment: appConfig.environment,
  release: '1.8.3'
}).install();

let logError = async err => {
  console.error(err);
  if (!devMode) {
    await new Promise(resolve => {
      Raven.captureException(err, {
        extra: {
          runConfig,
          user: runConfig.userId
        },
        user: runConfig.userId
      }, resolve);
    });
  }
}

let tablesNeeded = [
  "t_cookbook",
  // "t_cookbookchapter",
  // "t_cookbookchapterassocation",
  // "t_attachment", //2x unused
  "t_authornote", // seems to be a cross between description (short) and notes (long) - sometimes very long (multiple entries per recipe, divided paragraph)
  // "t_cookbook_x", // unused from this db afaik
  // "t_favorite_x", //2x unused
  // "t_favoritefolder", //2x unused
  // "t_glossaryitem",
  // "t_groceryaisle",
  // "t_grocerylistitemrecipe",
  "t_image", // Holds filenames for all images
  // "t_ingredient",
  // "t_ingredientattachment",
  // "t_ingredientautocomplete",
  // "t_ingredientfolder",
  // "t_ingredientfolder_x",
  // "t_ingredientimage",
  // "t_meal", // Holds meal names with an abbreviation. No reference to any other table
  // "t_measure",
  // "t_measure_x",
  // "t_menu", // Holds menu info - has some "types" info that might be useful for labelling
  // "t_menu_x", // unused
  // "t_menuimage",
  "t_recipe",
  // "t_recipe_x", //2x unused
  // "t_recipeattachment", // 2x unused
  "t_recipeimage", // bidirectional relation table between recipe and image
  "t_recipeingredient",
  // "t_recipemeasure",
  "t_recipeprocedure",
  // "t_recipereview",
  "t_technique",
  "t_recipetechnique",
  "t_recipetip",
  // "t_recipetype", // seems to store category names, but no discernable relationship to recipe table - better to use recipetypes field in recipe itself (comma separated)
  // "t_recipetype_x", //2x unused
  // "t_grocerylistitem",
  // "t_ingredient_x", //2x unused
  // "t_ingredientmeasure", //not entirely clear - looks like a relationship table between ingredients and measurements
  // "t_recipemedia" //2x unused (or barely used)
]

let sqliteDB;
let lcbDB;
let zipPath = runConfig.path;
let sqlitePath = zipPath + '-sqlite.db';
let extractPath = zipPath + '-extract';
let dbPath = zipPath + '-livingcookbook.mdb';
let lcbTables;
let tableMap = {};

let metrics = {
  t0: performance.now(),
  tExtracted: null,
  tExported: null,
  tSqliteStored: null,
  tSqliteFetched: null,
  tRecipeDataAssembled: null,
  tImagesUploaded: null,
  tRecipesProcessed: null,
  tRecipesSaved: null,
  tLabelsSaved: null
}

function cleanup() {
  try {
    sqliteDB.close();
  } catch (e) { }
  fs.removeSync(sqlitePath);
  fs.removeSync(zipPath);
  fs.removeSync(extractPath);
  fs.removeSync(dbPath);
}

async function main() {
  try {
    await (new Promise((resolve, reject) => {
      extract(zipPath, { dir: extractPath }, function (err) {
        if (err) {
          if (err.message === 'end of central directory record signature not found') err.status = 3;
          reject(err)
        }
        else resolve();
      })
    }))

    fs.unlinkSync(zipPath)

    let potentialDbPaths = await (UtilService.findFilesByRegex(extractPath, /\.mdb/i))
    if (potentialDbPaths.length == 0) throw new Error("No lcb db paths!");

    if (potentialDbPaths.length > 1) {
      console.log("More than one lcbdb path - ", potentialDbPaths)
      Raven.captureMessage("More than one lcbdb path - ", potentialDbPaths);
    } else {
      Raven.captureMessage("LCB DB Path - ", dbPath)
    }

    metrics.tExtracted = performance.now();

    await (new Promise((resolve, reject) => {
      let mv = spawn(`mv`, [potentialDbPaths[0], dbPath])
      mv.on('close', (code) => {
        code === 0 ? resolve() : reject("Move");
      });
    }))

    // Load mdb
    lcbDB = mdb(dbPath);

    // Load lcb schema
    await (new Promise((resolve, reject) => {
      exec(`mdb-schema ${dbPath} sqlite | sqlite3 ${sqlitePath}`, (err, stdout, stderr) => {
        console.log(err, stderr)
        err ? reject(err) : resolve();
      });
    }))

    // Load table list
    await (new Promise((resolve, reject) => {
      lcbDB.tables((err, tables) => {
        if (err) {
          reject(err);
        }
        lcbTables = tables.filter(table => tablesNeeded.indexOf(table) !== -1)

        resolve()
      })
    }))

    for (let i = 0; i < lcbTables.length; i++) {
      let table = lcbTables[i];
      await (new Promise((resolve, reject) => {
        // CRITICAL: Wrap call in a transaction for sqlite speed
        let cmd = `{ echo 'BEGIN;'; mdb-export -I sqlite ${dbPath} ${table}; echo 'COMMIT;'; } | sqlite3 ${sqlitePath}`;
        console.log(cmd);
        exec(cmd, (err, stdout, stderr) => {
          console.log(err, stderr, table)
          err ? reject() : resolve();
        });
      }))
    }

    metrics.tExported = performance.now();

    await (new Promise((resolve, reject) => {
      sqliteDB = new sqlite3.Database(sqlitePath, (err) => {
        if (err) reject(err)
        else resolve()
      })
    }));

    metrics.tSqliteStored = performance.now();

    await (Promise.all(lcbTables.map(tableName => {
      return new Promise(resolve => {
        sqliteDB.all("SELECT * FROM " + tableName, [], (err, results) => {
          if (err) throw err;

          tableMap[tableName] = results;

          resolve();
        })
      })
    })))

    metrics.tSqliteFetched = performance.now();
    // return await fs.writeFile('output', JSON.stringify(tableMap))

    let labelMap = {};

    let pendingRecipes = [];

    tableMap.t_recipe = (tableMap.t_recipe || [])
      .filter(lcbRecipe => !!lcbRecipe.recipeid && (runConfig.includeStockRecipes || !!lcbRecipe.modifieddate))

    let lcbImagesById = (tableMap.t_image || []).reduce((acc, image) => {
      acc[image.imageid] = image;
      return acc;
    }, {});

    let lcbImagesByRecipeId = (tableMap.t_recipeimage || []).reduce((acc, recipeImage) => {
      try {
        acc[recipeImage.recipeid] = acc[recipeImage.recipeid] || [];
        acc[recipeImage.recipeid].push({
          filename: lcbImagesById[recipeImage.imageid].filename,
          imageindex: parseInt(recipeImage.imageindex, 10)
        })
      } catch (e) { }
      return acc;
    }, {})

    let lcbTechniquesById = (tableMap.t_technique || []).reduce((acc, technique) => {
      acc[technique.techniqueid] = technique;
      return acc;
    }, {});

    let lcbTechniquesByRecipeId = (tableMap.t_recipetechnique || []).reduce((acc, lcbRecipeTechnique) => {
      try {
        acc[lcbRecipeTechnique.recipeid] = acc[lcbRecipeTechnique.recipeid] || [];
        acc[lcbRecipeTechnique.recipeid].push(lcbTechniquesById[lcbRecipeTechnique.techniqueid]);
      } catch (e) { }
      return acc;
    }, {});

    let lcbIngredientsByRecipeId = (tableMap.t_recipeingredient || []).reduce((acc, lcbIngredient) => {
      acc[lcbIngredient.recipeid] = acc[lcbIngredient.recipeid] || []
      acc[lcbIngredient.recipeid].push(lcbIngredient);
      return acc;
    }, {});

    let lcbInstructionsByRecipeId = (tableMap.t_recipeprocedure || []).reduce((acc, lcbInstruction) => {
      acc[lcbInstruction.recipeid] = acc[lcbInstruction.recipeid] || [];
      acc[lcbInstruction.recipeid].push(lcbInstruction);
      return acc;
    }, {});

    let lcbTipsByRecipeId = (tableMap.t_recipetip || []).reduce((acc, lcbTip) => {
      acc[lcbTip.recipeid] = acc[lcbTip.recipeid] || [];
      acc[lcbTip.recipeid].push(lcbTip);
      return acc;
    }, {});

    let lcbAuthorNotesByRecipeId = (tableMap.t_authornote || []).reduce((acc, lcbAuthorNote) => {
      acc[lcbAuthorNote.recipeid] = acc[lcbAuthorNote.recipeid] || [];
      acc[lcbAuthorNote.recipeid].push(lcbAuthorNote);
      return acc;
    }, {});

    let lcbCookbooksById = (tableMap.t_cookbook || []).reduce((acc, lcbCookbook) => {
      acc[lcbCookbook.cookbookid] = acc[lcbCookbook.cookbookid] || [];
      acc[lcbCookbook.cookbookid].push(lcbCookbook);
      return acc;
    }, {});

    metrics.tRecipeDataAssembled = performance.now();

    await (SQ.transaction(async t => {
      let recipesWithImages = runConfig.excludeImages ?
        [] : tableMap.t_recipe.map(lcbRecipe => {
          lcbRecipe.imageFileNames = (lcbImagesByRecipeId[lcbRecipe.recipeid] || [])
            .sort((a, b) => (a.imageindex || 0) - (b.imageindex || 0))
            .filter(e => e.filename)
            .map(e => e.filename);
          return lcbRecipe;
        }).filter(e => e.imageFileNames.length > 0);

      var i, chunkedRecipesWithImages = [], chunk = 50;
      for (i = 0; i < recipesWithImages.length; i += chunk) {
        chunkedRecipesWithImages.push(recipesWithImages.slice(i, i + chunk));
      }

      await chunkedRecipesWithImages.reduce((acc, lcbRecipeChunk) => {
        return acc.then(() => {
          return Promise.all(lcbRecipeChunk.map(lcbRecipe => {
            let imageFileNames = lcbRecipe.imageFileNames;

            if (imageFileNames.length == 0) return;

            // let possibleFileNameRegex = imageFileNames.join('|')
            let possibleFileNameRegex = imageFileNames[0];

            let possibleImageFiles = UtilService.findFilesByRegex(extractPath, new RegExp(`(${possibleFileNameRegex})$`, 'i'))

            if (possibleImageFiles.length == 0) return;

            return UtilService.sendFileToS3(possibleImageFiles[0]).then((image) => {
              lcbRecipe.savedS3Image = image;
            }).catch(() => { })
          }))
        })
      }, Promise.resolve())

      metrics.tImagesUploaded = performance.now();

      await Promise.all(tableMap.t_recipe.map(async lcbRecipe => {

        let image = lcbRecipe.savedS3Image || null;

        let ingredients = (lcbIngredientsByRecipeId[lcbRecipe.recipeid] || [])
          .filter(lcbIngredient => lcbIngredient)
          .sort((a, b) => a.ingredientindex > b.ingredientindex)
          .map(lcbIngredient => `${lcbIngredient.quantitytext || ''} ${lcbIngredient.unittext || ''} ${lcbIngredient.ingredienttext || ''}`)
          .join("\r\n")

        let instructions = (lcbInstructionsByRecipeId[lcbRecipe.recipeid] || [])
          .filter(lcbProcedure => lcbProcedure && lcbProcedure.proceduretext)
          .sort((a, b) => a.procedureindex > b.procedureindex)
          .map(lcbProcedure => lcbProcedure.proceduretext)
          .join("\r\n")

        let recipeTips = (lcbTipsByRecipeId[lcbRecipe.recipeid] || [])
          .filter(lcbTip => lcbTip && lcbTip.tiptext)
          .sort((a, b) => a.tipindex > b.tipindex)
          .map(lcbTip => lcbTip.tiptext)

        let authorNotes = (lcbAuthorNotesByRecipeId[lcbRecipe.recipeid] || [])
          .filter(lcbAuthorNote => lcbAuthorNote && lcbAuthorNote.authornotetext)
          .sort((a, b) => a.authornoteindex > b.authornoteindex)
          .map(lcbAuthorNote => lcbAuthorNote.authornotetext)

        let techniqueNotes = (lcbTechniquesByRecipeId[lcbRecipe.recipeid] || [])
          .filter(lcbTechnique => lcbTechnique && lcbTechnique.comments)
          .map(lcbTechnique => `${lcbTechnique.name}:\r\n${lcbTechnique.comments}`)

        if (!runConfig.includeTechniques) techniqueNotes = [];

        let description = ''

        let notes = []

        // Add comments to notes
        if (lcbRecipe.comments) notes.push(lcbRecipe.comments)

        // Add "author notes" to description or notes depending on length
        if (authorNotes.length == 1 && authorNotes[0].length <= 150) description = authorNotes[0]
        else if (authorNotes.length > 0) notes = [...notes, ...authorNotes]

        // Add recipeTips and join with double return
        notes = [...notes, ...recipeTips, ...techniqueNotes].join('\r\n\r\n')

        let createdAt = new Date(lcbRecipe.createdate || Date.now())
        let updatedAt = new Date(lcbRecipe.modifieddate || Date.now())

        let totalTime = (lcbRecipe.readyintime || '').toString().trim()
        if (lcbRecipe.cookingtime) {
          totalTime += ` (${lcbRecipe.cookingtime.toString().trim()} cooking time)`;
        }
        totalTime = totalTime.trim();

        let lcbRecipeLabels = [
          ...new Set([
            ...(lcbRecipe.recipetypes || '').split(',').map(el => el.trim().toLowerCase()),
            ...lcbCookbooksById[lcbRecipe.cookbookid].map(el => el.name.trim().toLowerCase())
          ])
        ].filter(el => el && el.length > 0)

        return pendingRecipes.push({
          model: {
            userId: runConfig.userId,
            title: lcbRecipe.recipename || '',
            description,
            yield: (lcbRecipe.yield || '').toString(),
            activeTime: (lcbRecipe.preparationtime || '').toString(),
            totalTime,
            source: lcbRecipe.source || '',
            url: lcbRecipe.webpage || '',
            notes,
            ingredients,
            instructions,
            image: image,
            folder: 'main',
            fromUserId: null,
            createdAt,
            updatedAt
          },
          lcbRecipeLabels
        })
      }));

      metrics.tRecipesProcessed = performance.now();

      let recipes = await Recipe.bulkCreate(pendingRecipes.map(el => el.model), {
        returning: true,
        transaction: t
      })

      recipes.map((recipe, idx) => {
        pendingRecipes[idx].lcbRecipeLabels.map(lcbLabelName => {
          labelMap[lcbLabelName] = labelMap[lcbLabelName] || [];
          labelMap[lcbLabelName].push(recipe.id);
        })
      })

      metrics.tRecipesSaved = performance.now();

      await Promise.all(Object.keys(labelMap).map(lcbLabelName => {
        return Label.findOrCreate({
          where: {
            userId: runConfig.userId,
            title: lcbLabelName
          },
          transaction: t
        }).then(labels => {
          return Recipe_Label.bulkCreate(labelMap[lcbLabelName].map(recipeId => {
            return {
              labelId: labels[0].id,
              recipeId
            }
          }), {
            transaction: t
          })
        });
      }))

      metrics.tLabelsSaved = performance.now();
    }))

    metrics.performance = {
      tExtract: Math.floor(metrics.tExtracted - metrics.t0),
      tExport: Math.floor(metrics.tExported - metrics.tExtracted),
      tSqliteStore: Math.floor(metrics.tSqliteStored - metrics.tExported),
      tSqliteFetch: Math.floor(metrics.tSqliteFetched - metrics.tSqliteStored),
      tRecipeDataAssemble: Math.floor(metrics.tRecipeDataAssembled - metrics.tSqliteFetched),
      tImagesUpload: Math.floor(metrics.tImagesUploaded - metrics.tRecipeDataAssembled),
      tRecipesProcess: Math.floor(metrics.tRecipesProcessed - metrics.tImagesUploaded),
      tRecipesSave: Math.floor(metrics.tRecipesSaved - metrics.tRecipesProcessed),
      tLabelsSave: Math.floor(metrics.tLabelsSaved - metrics.tRecipesSaved)
    }

    await new Promise(resolve => {
      Raven.captureMessage('LCB Metrics', {
        extra: {
          runConfig,
          metrics,
          user: runConfig.userId
        },
        user: runConfig.userId,
        level: 'info'
      }, resolve);
    });

    cleanup()

    process.exit(0);
  } catch (e) {
    cleanup();

    console.log("Couldn't handle lcb upload 2", e)
    await logError(e);

    try {
      if (e && e.status) {
        process.exit(e.status);
      } else process.exit(1);
    } catch (e) {
      process.exit(1);
    }
  }
}

main();
