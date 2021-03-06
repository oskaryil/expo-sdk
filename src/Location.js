// @flow
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import * as Permissions from './Permissions';
import invariant from 'invariant';

const LocationEventEmitter = new NativeEventEmitter(
  NativeModules.ExponentLocation
);

type ProviderStatus = {
  locationServicesEnabled: boolean,
  gpsAvailable: ?boolean,
  networkAvailable: ?boolean,
  passiveAvailable: ?boolean,
};

type LocationOptions = {
  enableHighAccuracy: ?boolean,
  timeInterval: ?number,
  distanceInterval: ?number,
};

type LocationData = {
  coords: {
    latitude: number,
    longitude: number,
    altitude: number,
    accuracy: number,
    heading: number,
    speed: number,
  },
  timestamp: number,
};

type HeadingData = {
  heading: {
    trueHeading: number,
    magHeading: number,
    accuracy: number,
  },
};

type LocationCallback = (data: LocationData) => any;
type HeadingCallback = (data: HeadingData) => any;

const { ExponentLocation } = NativeModules;

let nextWatchId = 0;
let headingId;
function _getNextWatchId() {
  nextWatchId++;
  return nextWatchId;
}
function _getCurrentWatchId() {
  return nextWatchId;
}

let watchCallbacks: {
  [watchId: number]: LocationCallback | HeadingCallback,
} = {};
let deviceEventSubscription: ?Function;
let headingEventSub: ?Function;

function getProviderStatusAsync(): Promise<ProviderStatus> {
  return ExponentLocation.getProviderStatusAsync();
}

function getCurrentPositionAsync(options: LocationOptions) {
  // On Android we have a native method for this case.
  if (Platform.OS === 'android') {
    return ExponentLocation.getCurrentPositionAsync(options);
  }

  // On iOS we implement it in terms of `.watchPositionAsync(...)`
  // TODO: Use separate native method for iOS too?
  return new Promise(async (resolve, reject) => {
    try {
      let done = false; // To make sure we only resolve once.
      let subscription;
      subscription = await watchPositionAsync(options, location => {
        if (!done) {
          resolve(location);
          done = true;
        }
        subscription.remove();
      });

      // In case the callback is fired before we get here.
      if (done) {
        subscription.remove();
      }
    } catch (e) {
      reject(e);
    }
  });
}

// Start Compass Module

// To simplify, we will call watchHeadingAsync and wait for one update
// To ensure accuracy, we wait for a couple of watch updates if the data has low accuracy
async function getHeadingAsync() {
  return new Promise(async (resolve, reject) => {
    try {
      // If there is already a compass active (would be a watch)
      if (headingEventSub) {
        let tries = 0;
        const headingSub = LocationEventEmitter.addListener(
          'Exponent.headingChanged',
          ({ watchId, heading }) => {
            if (heading.accuracy > 1 || tries > 5) {
              resolve(heading);
              LocationEventEmitter.removeSubscription(headingSub);
            } else {
              tries += 1;
            }
          }
        );
      } else {
        let done = false;
        let subscription;
        let tries = 0;
        subscription = await watchHeadingAsync(heading => {
          if (!done) {
            if (heading.accuracy > 1 || tries > 5) {
              subscription.remove();
              resolve(heading);
              done = true;
            } else {
              tries += 1;
            }
          } else {
            subscription.remove();
          }
        });

        if (done) {
          subscription.remove();
        }
      }
    } catch (e) {
      reject(e);
    }
  });
}

async function watchHeadingAsync(callback: HeadingCallback) {
  // Check if there is already a compass event watch.
  if (headingEventSub) {
    _removeHeadingWatcher(headingId);
  }

  headingEventSub = LocationEventEmitter.addListener(
    'Exponent.headingChanged',
    ({ watchId, heading }) => {
      const callback = watchCallbacks[watchId];
      if (callback) {
        callback(heading);
      } else {
        ExponentLocation.removeWatchAsync(watchId);
      }
    }
  );

  headingId = _getNextWatchId();
  watchCallbacks[headingId] = callback;
  await ExponentLocation.watchDeviceHeading(headingId);
  return {
    remove() {
      _removeHeadingWatcher(headingId);
    },
  };
}

// Removes the compass listener and sub from JS and Native
function _removeHeadingWatcher(watchId) {
  if (!watchCallbacks[watchId]) {
    return;
  }
  delete watchCallbacks[watchId];
  ExponentLocation.removeWatchAsync(watchId);
  LocationEventEmitter.removeSubscription(headingEventSub);
  headingEventSub = null;
}
// End Compass Module

function _maybeInitializeEmitterSubscription() {
  if (!deviceEventSubscription) {
    deviceEventSubscription = LocationEventEmitter.addListener(
      'Exponent.locationChanged',
      ({ watchId, location }) => {
        const callback = watchCallbacks[watchId];
        if (callback) {
          callback(location);
        } else {
          ExponentLocation.removeWatchAsync(watchId);
        }
      }
    );
  }
}

async function _askPermissionForWatchAsync(success, error, options, watchId) {
  let { status } = await Permissions.askAsync(Permissions.LOCATION);
  if (status === 'granted') {
    ExponentLocation.watchPositionImplAsync(watchId, options);
  } else {
    _removeWatcher(watchId);
    error({ watchId, message: 'No permission to access location' });
  }
}

// Polyfill: navigator.geolocation.watchPosition
function watchPosition(
  success: GeoSuccessCallback,
  error: GeoErrorCallback,
  options: LocationOptions
) {
  _maybeInitializeEmitterSubscription();

  const watchId = _getNextWatchId();
  watchCallbacks[watchId] = success;
  _askPermissionForWatchAsync(success, error, options, watchId);

  return watchId;
}

async function watchPositionAsync(
  options: LocationOptions,
  callback: LocationCallback
) {
  _maybeInitializeEmitterSubscription();

  const watchId = _getNextWatchId();
  watchCallbacks[watchId] = callback;
  await ExponentLocation.watchPositionImplAsync(watchId, options);

  return {
    remove() {
      _removeWatcher(watchId);
    },
  };
}

// Polyfill: navigator.geolocation.clearWatch
function clearWatch(watchId: number) {
  _removeWatcher(watchId);
}

function _removeWatcher(watchId) {
  // Do nothing if we have already removed the subscription
  if (!watchCallbacks[watchId]) {
    return;
  }

  ExponentLocation.removeWatchAsync(watchId);
  delete watchCallbacks[watchId];
  if (Object.keys(watchCallbacks).length === 0) {
    LocationEventEmitter.removeSubscription(deviceEventSubscription);
    deviceEventSubscription = null;
  }
}

type GeoSuccessCallback = (data: LocationData) => void;
type GeoErrorCallback = (error: any) => void;

function getCurrentPosition(
  success: GeoSuccessCallback,
  error?: GeoErrorCallback,
  options?: LocationOptions = {}
): void {
  invariant(
    typeof success === 'function',
    'Must provide a valid success callback.'
  );

  invariant(typeof options === 'object', 'options must be an object.');

  _getCurrentPositionAsyncWrapper(success, error, options);
}

// This function exists to let us continue to return undefined from
// getCurrentPosition, while still using async/await for the internal
// implementation of it
async function _getCurrentPositionAsyncWrapper(
  success: GeoSuccessCallback,
  error: GeoErrorCallback,
  options: LocationOptions
): Promise<*> {
  try {
    let { status } = await Permissions.askAsync(Permissions.LOCATION);
    if (status !== 'granted') {
      throw new Error(
        'Permission to access location not granted. User must now enable it manually in settings'
      );
    }

    let result = await Location.getCurrentPositionAsync(options);
    success(result);
  } catch (e) {
    error(e);
  }
}

// Polyfill navigator.geolocation for interop with the core react-native and
// web API approach to geolocation
const _polyfill = {
  getCurrentPosition,
  watchPosition,
  clearWatch,

  // We don't polyfill stopObserving, this is an internal method that probably
  // should not even exist in react-native docs
  stopObserving: () => {},
};
window.navigator.geolocation = _polyfill;

const Location = {
  getProviderStatusAsync,
  getCurrentPositionAsync,
  watchPositionAsync,
  getHeadingAsync,
  watchHeadingAsync,

  // For internal purposes  LocationEventEmitter,
  EventEmitter: LocationEventEmitter,
  _polyfill,
  _getCurrentWatchId,
};

export default Location;
