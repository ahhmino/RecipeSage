import { HttpClient, HttpHeaders, HttpErrorResponse } from '@angular/common/http';
// import { Observable } from 'rxjs/Observable';
import { ErrorObservable } from 'rxjs/observable/ErrorObservable';
import { Injectable } from '@angular/core';
import { catchError, retry } from 'rxjs/operators';
import { UtilServiceProvider } from '../util-service/util-service';

@Injectable()
export class UserServiceProvider {

  base: String;

  constructor(public http: HttpClient, public utilService: UtilServiceProvider) {}

  register(data) {
    const httpOptions = {
      headers: new HttpHeaders({
        'Content-Type':  'application/json'
      })
    };

    return this.http
    .post(this.utilService.getBase() + 'users/register', data, httpOptions)
    .pipe(
      catchError(this.handleError)
    );
  }

  login(data) {
    const httpOptions = {
      headers: new HttpHeaders({
        'Content-Type':  'application/json'
      })
    };

    return this.http
    .post(this.utilService.getBase() + 'users/login', data, httpOptions)
    .pipe(
      retry(1),
      catchError(this.handleError)
    );
  }

  logout() {
    const httpOptions = {
      headers: new HttpHeaders({
        'Content-Type': 'application/json'
      })
    };

    return this.http
      .post(this.utilService.getBase() + 'users/logout' + this.utilService.getTokenQuery(), {}, httpOptions)
      .pipe(
        retry(3),
        catchError(this.handleError)
      );
  }

  forgot(data) {
    const httpOptions = {
      headers: new HttpHeaders({
        'Content-Type': 'application/json'
      })
    };

    return this.http
      .post(this.utilService.getBase() + 'users/forgot', data, httpOptions)
      .pipe(
        retry(1),
        catchError(this.handleError)
      );
  }

  update(data) {
    const httpOptions = {
      headers: new HttpHeaders({
        'Content-Type':  'application/json'
      })
    };

    return this.http
    .put(this.utilService.getBase() + 'users/' + this.utilService.getTokenQuery(), data, httpOptions)
    .pipe(
      retry(1),
      catchError(this.handleError)
    );
  }

  saveFCMToken(key) {

    console.log("attempting save")
    var data = {
      fcmToken: key
    };

    const httpOptions = {
      headers: new HttpHeaders({
        'Content-Type':  'application/json'
      })
    };

    return this.http
    .post(this.utilService.getBase() + 'users/fcm/token' + this.utilService.getTokenQuery(), data, httpOptions)
    .pipe(
      catchError(this.handleError)
    );
  }

  removeFCMToken(key) {
    console.log("attempting delete")

    const httpOptions = {
      headers: new HttpHeaders({
        'Content-Type':  'application/json'
      })
    };

    return this.http
    .delete(this.utilService.getBase() + 'users/fcm/token' + this.utilService.getTokenQuery() + '&fcmToken=' + encodeURIComponent(key), httpOptions)
    .pipe(
      catchError(this.handleError)
    );
  }

  getUserByEmail(email) {
    const httpOptions = {
      headers: new HttpHeaders({
        'Content-Type':  'application/json'
      })
    };

    return this.http
    .get(this.utilService.getBase() + 'users/by-email' + this.utilService.getTokenQuery() + '&email=' + encodeURIComponent(email), httpOptions)
    .pipe(
      catchError(this.handleError)
    );
  }

  me() {
    const httpOptions = {
      headers: new HttpHeaders({
        'Content-Type':  'application/json'
      })
    };

    return this.http
    .get(this.utilService.getBase() + 'users/' + this.utilService.getTokenQuery(), httpOptions)
    .pipe(
      catchError(this.handleError)
    );
  }

  checkForUpdate(params) {
    const httpOptions = {
      headers: new HttpHeaders({
        'Content-Type':  'application/json'
      })
    };

    return this.http
    .get(this.utilService.getBase() + 'info/' + this.utilService.getTokenQuery() + '&version=' + encodeURIComponent(params.version), httpOptions)
    .pipe(
      catchError(this.handleError)
    );
  }

  private handleError(error: HttpErrorResponse) {
    if (error.error instanceof ErrorEvent) {
      // A client-side or network error occurred. Handle it accordingly.
      console.error('An error occurred:', error.error.message);
    } else {
      // The backend returned an unsuccessful response code.
      // The response body may contain clues as to what went wrong,
      console.error(
        `Backend returned code ${error.status}, ` +
        `body was: ${error.error}`);
    }
    // return an ErrorObservable with a user-facing error message
    return new ErrorObservable({
      msg: 'Something bad happened; please try again later.',
      status: error.status
    });
  }
}
