import { Component } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { DomSanitizer } from '@angular/platform-browser';
import { NavController, ToastController } from '@ionic/angular';
import loadImage from 'blueimp-load-image';

import { UtilService } from '@/services/util.service';
import { RecipeService, Recipe } from '@/services/recipe.service';
import { LoadingService } from '@/services/loading.service';

@Component({
  selector: 'page-edit-recipe',
  templateUrl: 'edit-recipe.page.html',
  styleUrls: ['edit-recipe.page.scss'],
  providers: [ RecipeService ]
})
export class EditRecipePage {

  recipeId: string;
  recipe: Recipe = {} as Recipe;

  imageBlobURL: any;

  constructor(
    public route: ActivatedRoute,
    public navCtrl: NavController,
    public toastCtrl: ToastController,
    public utilService: UtilService,
    public loadingService: LoadingService,
    public recipeService: RecipeService,
    public domSanitizationService: DomSanitizer) {

    const recipeId = this.route.snapshot.paramMap.get('recipeId');

    if (recipeId !== 'new') {
      this.recipeId = recipeId;

      const loading = this.loadingService.start();
      this.recipeService.fetchById(this.recipeId).then(recipe => {
        this.recipe = recipe;
        loading.dismiss();
      }).catch(async err => {
        loading.dismiss();
        switch (err.status) {
          case 0:
            const offlineToast = await this.toastCtrl.create({
              message: this.utilService.standardMessages.offlinePushMessage,
              duration: 5000
            });
            offlineToast.present();
            break;
          case 401:
            this.goToAuth();
            break;
          case 404:
            const notFoundToast = await this.toastCtrl.create({
              message: 'Recipe not found. Does this recipe URL exist?',
              duration: 30000 // TODO: Should offer a dismiss button
            });
            notFoundToast.present();
            break;
          default:
            const unexpectedErrorToast = await this.toastCtrl.create({
              message: this.utilService.standardMessages.unexpectedError,
              duration: 6000
            });
            unexpectedErrorToast.present();
            break;
        }
      });
    }
  }

  getScrollHeight(el) {
    return el.scrollHeight + 1;
  }

  ionViewWillEnter() {
    var textAreas = document.getElementsByTagName('textarea');
    for (var i = 0; i < textAreas.length; i++) {
      textAreas[i].style.height = `${this.getScrollHeight(textAreas[i])}px`;
    }
  }

  updateTextAreaSize(event) {
    var el = event.target.children[0];
    el.style.height = 'auto';
    el.style.height = `${this.getScrollHeight(el)}px`;
  }

  goToAuth(cb?: Function) {
    // TODO: Needs functionality
  }

  async setFile(event) {
    let files = event.srcElement.files
    if (!files || !files[0]) {
      return
    }

    let MAX_FILE_SIZE_MB = 8;
    let ENABLE_LOCAL_CONVERSIONS = true;
    let isOverMaxSize = files[0].size / 1024 / 1024 > MAX_FILE_SIZE_MB; // Image is larger than MAX_FILE_SIZE_MB

    if (!isOverMaxSize) {
      // Image size is OK, upload the image directly for high quality server conversion
      console.log(`Image is under ${MAX_FILE_SIZE_MB}MB`);
      this.recipe.imageFile = files[0];
      this.imageBlobURL = this.domSanitizationService.bypassSecurityTrustUrl(
        (window.URL || (<any>window).webkitURL).createObjectURL(this.recipe.imageFile)
      );
    } else if (isOverMaxSize && ENABLE_LOCAL_CONVERSIONS) {
      // Image is too large, do some resizing before high quality server conversion
      console.log(`Image is over ${MAX_FILE_SIZE_MB}MB. Converting locally`);
      var loadingImage = loadImage(
        files[0],
        (renderedCanvas, exif) => {
          renderedCanvas.toBlob(myBlob => {
            myBlob.name = this.recipe.imageFile.name;
            this.recipe.imageFile = myBlob;
            this.imageBlobURL = this.domSanitizationService.bypassSecurityTrustUrl(
              (window.URL || (<any>window).webkitURL).createObjectURL(this.recipe.imageFile)
            );

            console.log('Local conversion complete');
          }, 'image/jpeg', 1);
        },
        {
          maxWidth: 800,
          maxHeight: 800,
          crop: true,
          canvas: true,
          orientation: true
        }
      );

      loadingImage.onerror = async err => {
        // Image is too large and local conversion failed
        console.log(`Image is over ${MAX_FILE_SIZE_MB}MB. Local conversion failed`);
        (await this.toastCtrl.create({
          message: `The max image file size is ${MAX_FILE_SIZE_MB}MB. Please select a smaller image.`,
          duration: 6000
        })).present();
      };
    } else {
      // Image is too large and local conversions are not enabled
      console.log(`Image is over ${MAX_FILE_SIZE_MB}MB. Local conversion not enabled`);
      (await this.toastCtrl.create({
        message: `The max image file size is ${MAX_FILE_SIZE_MB}MB. Please select a smaller image.`,
        duration: 6000
      })).present();
    }
  }

  async save() {
    if (!this.recipe.title || this.recipe.title.length === 0) {
      (await this.toastCtrl.create({
        message: 'Please provide a recipe title (the only required field).',
        duration: 6000
      })).present();
      return;
    }

    var loading = this.loadingService.start();

    if (this.recipe.id) {
      this.recipeService.update(this.recipe).then(response => {
        // this.navCtrl.setRoot('HomePage', { folder: 'main' }, { animate: false });
        // this.navCtrl.push('RecipePage', {
        //   recipe: response,
        //   recipeId: response.id
        // });

        loading.dismiss();
      }).catch(async err => {
        loading.dismiss();
        switch(err.status) {
          case 0:
            (await this.toastCtrl.create({
              message: this.utilService.standardMessages.offlinePushMessage,
              duration: 5000
            })).present();
            break;
          case 401:
            (await this.toastCtrl.create({
              message: this.utilService.standardMessages.unauthorized,
              duration: 6000
            })).present();
            break;
          default:
            (await this.toastCtrl.create({
              message: this.utilService.standardMessages.unexpectedError,
              duration: 6000
            })).present();
            break;
        }
      });
    } else {
      this.recipeService.create(this.recipe).then(response => {
        // this.navCtrl.setRoot('HomePage', { folder: 'main' }, { animate: false });
        // this.navCtrl.push('RecipePage', {
        //   recipe: response,
        //   recipeId: response.id
        // });

        loading.dismiss();
      }).catch(async err => {
        loading.dismiss();
        switch(err.status) {
          case 0:
            (await this.toastCtrl.create({
              message: this.utilService.standardMessages.offlinePushMessage,
              duration: 5000
            })).present();
            break;
          case 401:
            (await this.toastCtrl.create({
              message: this.utilService.standardMessages.unauthorized,
              duration: 6000
            })).present();
            break;
          case 412:
            (await this.toastCtrl.create({
              message: 'Please provide a recipe title (the only required field).',
              duration: 6000
            })).present();
            break;
          default:
            (await this.toastCtrl.create({
              message: this.utilService.standardMessages.unexpectedError,
              duration: 6000
            })).present();
            break;
        }
      });
    }
  }

  filePicker() {
    document.getElementById('filePicker').click();
  }

  filePickerText() {
    if (this.recipe.imageFile) {
      return this.recipe.imageFile.name + ' Selected';
    } else if (this.recipe.image) {
      return 'Choose new image';
    } else {
      return 'Choose image';
    }
  }

}
