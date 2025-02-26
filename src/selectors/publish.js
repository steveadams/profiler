/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import { createSelector } from 'reselect';
import clamp from 'clamp';

import {
  getProfile,
  getProfileRootRange,
  getCommittedRange,
  getGlobalTracks,
  getLocalTracksByPid,
  getHasPreferenceMarkers,
  getThreads,
} from './profile';
import { compress } from '../utils/gz';
import { serializeProfile } from '../profile-logic/process-profile';
import {
  sanitizePII,
  getShouldSanitizeByDefault as getShouldSanitizeByDefaultImpl,
  type SanitizeProfileResult,
} from '../profile-logic/sanitize';
import prettyBytes from '../utils/pretty-bytes';
import { ensureExists } from '../utils/flow';
import { formatNumber } from '../utils/format-numbers';
import { getHiddenGlobalTracks, getHiddenLocalTracksByPid } from './url-state';

import type {
  PublishState,
  UploadState,
  UploadPhase,
  State,
  Selector,
  CheckedSharingOptions,
  RemoveProfileInformation,
  DerivedMarkerInfo,
} from 'firefox-profiler/types';
import { getThreadSelectors } from './per-thread';

export const getPublishState: Selector<PublishState> = (state) => state.publish;

export const getCheckedSharingOptions: Selector<CheckedSharingOptions> = (
  state
) => getPublishState(state).checkedSharingOptions;

export const getFilenameString: Selector<string> = createSelector(
  getProfile,
  getProfileRootRange,
  (profile, rootRange) => {
    const { startTime, product } = profile.meta;

    // Pad single digit numbers with a 0.
    const pad = (x) => (x < 10 ? `0${x}` : `${x}`);

    // Compute the date string.
    const date = new Date(startTime + rootRange.start);
    const year = pad(date.getFullYear());
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hour = pad(date.getHours());
    const min = pad(date.getMinutes());
    const dateString = `${year}-${month}-${day} ${hour}.${min}`;

    // Return the final file name
    return `${product} ${dateString} profile.json`;
  }
);

export const getRemoveProfileInformation: Selector<RemoveProfileInformation | null> =
  createSelector(
    getCheckedSharingOptions,
    getProfile,
    getCommittedRange,
    getHiddenGlobalTracks,
    getHiddenLocalTracksByPid,
    getGlobalTracks,
    getLocalTracksByPid,
    getHasPreferenceMarkers,
    (
      checkedSharingOptions,
      profile,
      committedRange,
      hiddenGlobalTracks,
      hiddenLocalTracksByPid,
      globalTracks,
      localTracksByPid,
      hasPreferenceMarkers
    ) => {
      let isIncludingEverything = true;
      for (const prop in checkedSharingOptions) {
        // Do not include preference values checkbox if it's hidden.
        // Even though `includePreferenceValues` is not taken into account, it's
        // is false, if the profile updateChannel is not nightly or custom build.
        if (prop === 'includePreferenceValues' && !hasPreferenceMarkers) {
          continue;
        }
        isIncludingEverything =
          isIncludingEverything && checkedSharingOptions[prop];
      }
      if (isIncludingEverything) {
        // No sanitization is happening, bail out early.
        return null;
      }

      // Find all of the thread indexes that are hidden.
      const shouldRemoveThreads = new Set();
      if (!checkedSharingOptions.includeHiddenThreads) {
        for (const globalTrackIndex of hiddenGlobalTracks) {
          const globalTrack = globalTracks[globalTrackIndex];
          if (
            globalTrack.type === 'process' &&
            globalTrack.mainThreadIndex !== null
          ) {
            // This is a process thread that has been hidden.
            shouldRemoveThreads.add(globalTrack.mainThreadIndex);
            const localTracks = ensureExists(
              localTracksByPid.get(globalTrack.pid),
              'Expected to be able to get a local track by PID.'
            );

            // Also add all of the children threads, as they are hidden as well.
            for (const localTrack of localTracks) {
              if (localTrack.type === 'thread') {
                shouldRemoveThreads.add(localTrack.threadIndex);
              }
            }
          }
        }

        // Add all of the local tracks that have been hidden.
        for (const [pid, hiddenLocalTrackIndexes] of hiddenLocalTracksByPid) {
          const localTracks = ensureExists(
            localTracksByPid.get(pid),
            'Expected to be able to get a local track by PID'
          );
          for (const hiddenLocalTrackIndex of hiddenLocalTrackIndexes) {
            const localTrack = localTracks[hiddenLocalTrackIndex];
            if (localTrack.type === 'thread') {
              shouldRemoveThreads.add(localTrack.threadIndex);
            }
          }
        }
      }

      return {
        shouldFilterToCommittedRange: checkedSharingOptions.includeFullTimeRange
          ? null
          : committedRange,
        shouldRemoveUrls: !checkedSharingOptions.includeUrls,
        shouldRemoveThreadsWithScreenshots: new Set(
          checkedSharingOptions.includeScreenshots
            ? []
            : profile.threads.map((_, threadIndex) => threadIndex)
        ),
        shouldRemoveThreads,
        shouldRemoveExtensions: !checkedSharingOptions.includeExtension,
        shouldRemovePreferenceValues:
          !checkedSharingOptions.includePreferenceValues,
      };
    }
  );

/**
 * The derived markers are needed for profile sanitization, but they are also
 * needed for each thread. This means that we can't use the createSelector
 * mechanism to properly memoize the component. We need access to the full state
 * and to the individual threads. This function therefore implements some simple
 * memoization behavior on the current list of threads.
 */
let _threads = null;
let _derivedMarkerInfo = null;
function getDerivedMarkerInfoForAllThreads(state: State): DerivedMarkerInfo[] {
  const threads = getThreads(state);
  if (_threads !== threads || _derivedMarkerInfo === null) {
    _threads = threads;
    _derivedMarkerInfo = getThreads(state).map((_, threadIndex) =>
      getThreadSelectors(threadIndex).getDerivedMarkerInfo(state)
    );
  }
  return _derivedMarkerInfo;
}

/**
 * Run the profile sanitization step, and also get information about how any
 * UrlState needs to be updated, with things like mapping thread indexes,
 * or providing a new committed range.
 */
export const getSanitizedProfile: Selector<SanitizeProfileResult> =
  createSelector(
    getProfile,
    getDerivedMarkerInfoForAllThreads,
    getRemoveProfileInformation,
    sanitizePII
  );

/**
 * Computing the compressed data for a profile is a potentially slow operation. This
 * selector and its consumers perform that operation asynchronously. It can be called
 * multiple times while adjust the PII sanitization, but should happen in the background.
 * It happens in the selector so that it can be shared across components and actions.
 *
 * Due to this memoization strategy, one copy of the data is retained in memory and
 * never freed.
 */
export const getSanitizedProfileData: Selector<Promise<Uint8Array>> =
  createSelector(getSanitizedProfile, ({ profile }) =>
    compress(serializeProfile(profile))
  );

/**
 * The blob is needed for both the download size, and the ObjectURL.
 */
export const getCompressedProfileBlob: Selector<Promise<Blob>> = createSelector(
  getSanitizedProfileData,
  async (profileData) =>
    new Blob([await profileData], { type: 'application/octet-binary' })
);

export const getDownloadSize: Selector<Promise<string>> = createSelector(
  getCompressedProfileBlob,
  (blobPromise) => blobPromise.then((blob) => prettyBytes(blob.size))
);

export const getUploadState: Selector<UploadState> = (state) =>
  getPublishState(state).upload;

export const getUploadPhase: Selector<UploadPhase> = (state) =>
  getUploadState(state).phase;

export const getUploadGeneration: Selector<number> = (state) =>
  getUploadState(state).generation;

export const getUploadProgress: Selector<number> = createSelector(
  getUploadState,
  ({ uploadProgress }) =>
    // Create a minimum value of 0.1 so that there is at least some user feedback
    // that the upload started, and a maximum value of 0.95 so that the user
    // doesn't wait with a full bar (there's still some work to do after the
    // uplod succeeds).
    clamp(uploadProgress, 0.1, 0.95)
);

export const getUploadError: Selector<Error | mixed> = (state) =>
  getUploadState(state).error;

export const getUploadProgressString: Selector<string> = createSelector(
  getUploadProgress,
  (progress) => formatNumber(progress, 0, 0, 'percent')
);

export const getAbortFunction: Selector<() => void> = (state) =>
  getUploadState(state).abortFunction;

export const getShouldSanitizeByDefault: Selector<boolean> = createSelector(
  getProfile,
  getShouldSanitizeByDefaultImpl
);

export const getPrePublishedState: Selector<null | State> = (state) =>
  getPublishState(state).prePublishedState;

export const getHasPrePublishedState: Selector<boolean> = (state) =>
  Boolean(getPrePublishedState(state));

export const getIsHidingStaleProfile: Selector<boolean> = (state) =>
  getPublishState(state).isHidingStaleProfile;

export const getHasSanitizedProfile: Selector<boolean> = (state) =>
  getPublishState(state).hasSanitizedProfile;
