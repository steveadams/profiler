/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow
import { storeWithProfile } from '../fixtures/stores';
import { getProfileFromTextSamples } from '../fixtures/profiles/processed-profile';
import {
  completeSymbolTable,
  partialSymbolTable,
} from '../fixtures/example-symbol-table';
import type { ExampleSymbolTable } from '../fixtures/example-symbol-table';
import { SymbolStore } from '../../profile-logic/symbol-store.js';
import * as ProfileViewSelectors from '../../selectors/profile';
import { selectedThreadSelectors } from '../../selectors/per-thread';
import { resourceTypes } from '../../profile-logic/data-structures';
import { doSymbolicateProfile } from '../../actions/receive-profile';
import {
  changeSelectedCallNode,
  changeExpandedCallNodes,
} from '../../actions/profile-view';
import { formatTree } from '../fixtures/utils';
import { assertSetContainsOnly } from '../fixtures/custom-assertions';

import fakeIndexedDB from 'fake-indexeddb';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
import { TextDecoder } from 'util';
import { SymbolsNotFoundError } from '../../profile-logic/errors';

/**
 * Symbolication happens across actions and reducers, so test this functionality in
 * its own file.
 */
describe('doSymbolicateProfile', function () {
  const symbolStoreName = 'test-db';
  beforeAll(function () {
    // The SymbolStore requires IndexedDB, otherwise symbolication will be skipped.
    window.indexedDB = fakeIndexedDB;
    window.IDBKeyRange = FDBKeyRange;
    window.TextDecoder = TextDecoder;
  });

  afterAll(async function () {
    delete window.indexedDB;
    delete window.IDBKeyRange;
    delete window.TextDecoder;
    await _deleteDatabase(`${symbolStoreName}-symbol-tables`);
  });

  // Initialize a store, an unsymbolicated profile, and helper functions.
  function init() {
    // The rejection in `requestSymbolsFromServer` outputs an error log, let's
    // silence it here. The fact that we call it is tested in
    // symbol-store.test.js.
    jest.spyOn(console, 'log').mockImplementation(() => {});

    const profile = _createUnsymbolicatedProfile();
    const store = storeWithProfile(profile);

    let symbolTable = completeSymbolTable;
    function switchSymbolTable(otherSymbolTable: ExampleSymbolTable) {
      symbolTable = otherSymbolTable;
    }
    let symbolicationProviderMode: 'from-server' | 'from-browser' =
      'from-browser';
    function switchSymbolProviderMode(newMode: 'from-server' | 'from-browser') {
      symbolicationProviderMode = newMode;
    }

    const symbolProvider = {
      requestSymbolsFromServer: (requests) =>
        requests.map(async (request) => {
          if (request.lib.debugName !== 'firefox.pdb') {
            throw new SymbolsNotFoundError(
              'Should only have lib called firefox.pdb',
              request.lib
            );
          }
          if (symbolicationProviderMode !== 'from-server') {
            throw new SymbolsNotFoundError(
              'Not in from-server mode, try requestSymbolTableFromBrowser.',
              request.lib
            );
          }

          const map = new Map();
          for (const address of request.addresses) {
            const addressResult = symbolTable.getAddressResult(address);
            if (addressResult !== null) {
              map.set(address, addressResult);
            }
          }
          return map;
        }),

      requestSymbolTableFromBrowser: async (lib) => {
        if (lib.debugName !== 'firefox.pdb') {
          throw new SymbolsNotFoundError(
            'Should only have libs called firefox.pdb',
            lib
          );
        }
        if (symbolicationProviderMode !== 'from-browser') {
          throw new Error(
            'should not call requestSymbolTableFromBrowser if requestSymbolsFromServer is successful'
          );
        }

        return symbolTable.asTuple;
      },
    };

    return {
      profile,
      store,
      // Provide an easy way to turn func names to current func indexes.
      funcNamesToFuncIndexes: (names: string[]) =>
        names.map((name) => {
          // Get the current thread in the store every time this is called, so it
          // is always up to date for the latest store changes. This is a convenience
          // to make the tests easier to read.
          const thread = getThread(store.getState());
          const stringIndex = thread.stringTable.indexForString(name);
          return thread.funcTable.name.indexOf(stringIndex);
        }),
      switchSymbolTable,
      switchSymbolProviderMode,
      symbolStore: new SymbolStore(symbolStoreName, symbolProvider),
    };
  }

  const {
    getSelectedCallNodePath,
    getExpandedCallNodePaths,
    getThread,
    getCallTree,
  } = selectedThreadSelectors;

  describe('doSymbolicateProfile', function () {
    it('can symbolicate a profile when symbols come from-browser', async () => {
      const {
        store: { dispatch, getState },
        profile,
        symbolStore,
      } = init();
      expect(formatTree(getCallTree(getState()))).toEqual([
        '- 0x000a (total: 1, self: —)',
        '  - 0x2000 (total: 1, self: 1)',
        '- 0x0000 (total: 1, self: —)',
        '  - 0x2000 (total: 1, self: 1)',
        '- 0x1a0f (total: 1, self: 1)',
        '- 0x0f0f (total: 1, self: 1)',
      ]);

      await doSymbolicateProfile(dispatch, profile, symbolStore);
      expect(formatTree(getCallTree(getState()))).toEqual([
        // 0x0000 and 0x000a get merged together.
        '- first symbol (total: 2, self: —)',
        '  - last symbol (total: 2, self: 2)',
        '- third symbol (total: 1, self: 1)',
        '- second symbol (total: 1, self: 1)',
      ]);
    });

    it('can symbolicate a profile when symbols come from-server', async () => {
      // Get rid of any cached symbol tables from the previous test.
      await _deleteDatabase(`${symbolStoreName}-symbol-tables`);

      const {
        store: { dispatch, getState },
        profile,
        symbolStore,
        switchSymbolProviderMode,
        funcNamesToFuncIndexes,
      } = init();
      expect(formatTree(getCallTree(getState()))).toEqual([
        '- 0x000a (total: 1, self: —)',
        '  - 0x2000 (total: 1, self: 1)',
        '- 0x0000 (total: 1, self: —)',
        '  - 0x2000 (total: 1, self: 1)',
        '- 0x1a0f (total: 1, self: 1)',
        '- 0x0f0f (total: 1, self: 1)',
      ]);

      switchSymbolProviderMode('from-server');

      await doSymbolicateProfile(dispatch, profile, symbolStore);
      expect(formatTree(getCallTree(getState()))).toEqual([
        // 0x0000 and 0x000a get merged together.
        '- first symbol (total: 2, self: —)',
        '  - last symbol (total: 2, self: 2)',
        '- third symbol (total: 1, self: 1)',
        '- second symbol (total: 1, self: 1)',
      ]);

      const symbolicatedProfile = ProfileViewSelectors.getProfile(getState());
      const thread = symbolicatedProfile.threads[0];
      const { frameTable, funcTable, stringTable } = thread;
      expect(funcTable.length).toBeGreaterThanOrEqual(4);

      const [
        firstSymbolFuncIndex,
        secondSymbolFuncIndex,
        thirdSymbolFuncIndex,
        lastSymbolFuncIndex,
      ] = funcNamesToFuncIndexes([
        'first symbol',
        'second symbol',
        'third symbol',
        'last symbol',
      ]);

      // The first and last symbol function should have the filename first_and_last.cpp.
      expect(funcTable.fileName[firstSymbolFuncIndex]).toBe(
        funcTable.fileName[lastSymbolFuncIndex]
      );
      let fileNameStringIndex = funcTable.fileName[firstSymbolFuncIndex];
      expect(fileNameStringIndex).not.toBeNull();
      let fileName =
        fileNameStringIndex !== null
          ? stringTable.getString(fileNameStringIndex)
          : '<null>';
      expect(fileName).toBe('first_and_last.cpp');

      // The second and third symbol function should have the filename second_and_third.rs.
      expect(funcTable.fileName[secondSymbolFuncIndex]).toBe(
        funcTable.fileName[thirdSymbolFuncIndex]
      );
      fileNameStringIndex = funcTable.fileName[secondSymbolFuncIndex];
      expect(fileNameStringIndex).not.toBeNull();
      fileName =
        fileNameStringIndex !== null
          ? stringTable.getString(fileNameStringIndex)
          : '<null>';
      expect(fileName).toBe('second_and_third.rs');

      // Check line numbers.

      // First, find the frame for 0x0000, and make sure there's only one.
      const frameAt0x0000 = frameTable.address.indexOf(0x0000);
      expect(frameAt0x0000).not.toBe(-1);
      expect(frameTable.address.indexOf(0x0000, frameAt0x0000 + 1)).toBe(-1);
      // 0x0000 should be at line 12.
      expect(frameTable.line[frameAt0x0000]).toBe(12);

      // Now, find the frame for 0x000a, and make sure there's only one.
      const frameAt0x000a = frameTable.address.indexOf(0x000a);
      expect(frameAt0x000a).not.toBe(-1);
      expect(frameTable.address.indexOf(0x000a, frameAt0x000a + 1)).toBe(-1);
      // 0x000a should be at line 14.
      expect(frameTable.line[frameAt0x000a]).toBe(14);
    });

    it('updates the symbolication status', async () => {
      const {
        store: { dispatch, getState },
        profile,
        symbolStore,
      } = init();
      // Starts out as DONE.
      expect(ProfileViewSelectors.getSymbolicationStatus(getState())).toEqual(
        'DONE'
      );
      const symbolication = doSymbolicateProfile(
        dispatch,
        profile,
        symbolStore
      );
      expect(ProfileViewSelectors.getSymbolicationStatus(getState())).toEqual(
        'SYMBOLICATING'
      );
      await symbolication;
      expect(ProfileViewSelectors.getSymbolicationStatus(getState())).toEqual(
        'DONE'
      );
    });
  });

  describe('merging of functions with different memory addresses, but in the same function', () => {
    it('starts with expanded call nodes of multiple memory addresses', async function () {
      // Don't use the mocks on this test, as no SymbolStore database is needed.
      const {
        store: { dispatch, getState },
        funcNamesToFuncIndexes,
      } = init();

      const threadIndex = 0;
      const selectedCallNodePath = funcNamesToFuncIndexes(['0x000a', '0x2000']);
      // Both of these expanded nodes are actually in the same function, but
      // they are different memory addresses.
      const expandedCallNodePaths = [['0x000a'], ['0x0000']].map(
        funcNamesToFuncIndexes
      );

      dispatch(changeSelectedCallNode(threadIndex, selectedCallNodePath));
      dispatch(changeExpandedCallNodes(threadIndex, expandedCallNodePaths));

      expect(getSelectedCallNodePath(getState())).toEqual(selectedCallNodePath);
      assertSetContainsOnly(
        getExpandedCallNodePaths(getState()),
        expandedCallNodePaths
      );
    });

    it('symbolicates and merges functions in the stored call node paths', async function () {
      const {
        store: { dispatch, getState },
        profile,
        symbolStore,
        funcNamesToFuncIndexes,
      } = init();

      const threadIndex = 0;
      const selectedCallNodePath = funcNamesToFuncIndexes(['0x000a', '0x2000']);
      const expandedCallNodePaths = [['0x000a'], ['0x0000']].map(
        funcNamesToFuncIndexes
      );

      dispatch(changeSelectedCallNode(threadIndex, selectedCallNodePath));
      // Both of these expanded nodes are actually in the same function, but
      // they are different memory addresses. See exampleSymbolTable and
      // _createUnsymbolicatedProfile().
      dispatch(changeExpandedCallNodes(threadIndex, expandedCallNodePaths));
      expect(getSelectedCallNodePath(getState())).toEqual(selectedCallNodePath);
      assertSetContainsOnly(
        getExpandedCallNodePaths(getState()),
        expandedCallNodePaths
      );

      await doSymbolicateProfile(dispatch, profile, symbolStore);
      expect(getSelectedCallNodePath(getState())).toEqual(
        // The CallNodePath is now symbolicated.
        funcNamesToFuncIndexes(['first symbol', 'last symbol'])
      );

      assertSetContainsOnly(
        getExpandedCallNodePaths(getState()),
        [['first symbol']].map(funcNamesToFuncIndexes)
      );
    });
  });

  it('can symbolicate a profile with a partial symbol table and re-symbolicate it with a complete symbol table', async () => {
    // Get rid of any cached symbol tables from the previous tests.
    await _deleteDatabase(`${symbolStoreName}-symbol-tables`);

    const {
      store: { dispatch, getState },
      symbolStore,
      switchSymbolTable,
      switchSymbolProviderMode,
    } = init();

    let profile = ProfileViewSelectors.getProfile(getState());

    switchSymbolProviderMode('from-server');
    switchSymbolTable(partialSymbolTable);

    expect(formatTree(getCallTree(getState()))).toEqual([
      '- 0x000a (total: 1, self: —)',
      '  - 0x2000 (total: 1, self: 1)',
      '- 0x0000 (total: 1, self: —)',
      '  - 0x2000 (total: 1, self: 1)',
      '- 0x1a0f (total: 1, self: 1)',
      '- 0x0f0f (total: 1, self: 1)',
    ]);

    await doSymbolicateProfile(dispatch, profile, symbolStore);
    profile = ProfileViewSelectors.getProfile(getState());

    expect(formatTree(getCallTree(getState()))).toEqual([
      // 0x0000, 0x000a, 0x0f0f and 0x1a0f get merged together.
      '- overencompassing first symbol (total: 4, self: 2)',
      '  - last symbol (total: 2, self: 2)',
    ]);

    switchSymbolTable(completeSymbolTable);

    await doSymbolicateProfile(dispatch, profile, symbolStore);
    expect(formatTree(getCallTree(getState()))).toEqual([
      // "overencompassing first symbol" gets split into "first symbol",
      // "second symbol" and "third symbol".
      '- first symbol (total: 2, self: —)',
      '  - last symbol (total: 2, self: 2)',
      '- third symbol (total: 1, self: 1)',
      '- second symbol (total: 1, self: 1)',
    ]);
  });

  it('can re-symbolicate a partially-symbolicated profile even if it needs to add funcs to the funcTable', async () => {
    // Get rid of any cached symbol tables from the previous tests.
    await _deleteDatabase(`${symbolStoreName}-symbol-tables`);

    const {
      store: { dispatch, getState },
      symbolStore,
      switchSymbolTable,
      switchSymbolProviderMode,
    } = init();

    let profile = ProfileViewSelectors.getProfile(getState());

    switchSymbolProviderMode('from-server');
    switchSymbolTable(partialSymbolTable);

    expect(formatTree(getCallTree(getState()))).toEqual([
      '- 0x000a (total: 1, self: —)',
      '  - 0x2000 (total: 1, self: 1)',
      '- 0x0000 (total: 1, self: —)',
      '  - 0x2000 (total: 1, self: 1)',
      '- 0x1a0f (total: 1, self: 1)',
      '- 0x0f0f (total: 1, self: 1)',
    ]);

    await doSymbolicateProfile(dispatch, profile, symbolStore);
    profile = ProfileViewSelectors.getProfile(getState());

    expect(formatTree(getCallTree(getState()))).toEqual([
      // 0x0000, 0x000a, 0x0f0f and 0x1a0f get merged together.
      '- overencompassing first symbol (total: 4, self: 2)',
      '  - last symbol (total: 2, self: 2)',
    ]);

    const thread = profile.threads[0];
    const { frameTable, funcTable, nativeSymbols } = thread;
    expect(funcTable.length).toBeGreaterThanOrEqual(2);
    expect(nativeSymbols.length).toBeGreaterThanOrEqual(2);

    // Only nativeSymbol 0 and 1 should be in use. These are the funcs for the first and
    // last symbol.
    expect(frameTable.nativeSymbol).toContain(0);
    expect(frameTable.nativeSymbol).toContain(1);
    expect(new Set(frameTable.nativeSymbol).size).toBe(2);
    // The same should be true for the funcs.
    expect(frameTable.func).toContain(0);
    expect(frameTable.func).toContain(1);
    expect(new Set(frameTable.func).size).toBe(2);

    // Now forcefully truncate nativeSymbols and funcTable.
    const newFuncTable = { ...funcTable, length: 2 };
    const newNativeSymbols = { ...nativeSymbols, length: 2 };
    const newThread = {
      ...thread,
      funcTable: newFuncTable,
      nativeSymbols: newNativeSymbols,
    };
    const newProfile = { ...profile, threads: [newThread] };
    dispatch({
      type: 'PROFILE_LOADED',
      profile: newProfile,
      implementationFilter: undefined,
      pathInZipFile: undefined,
      transformStacks: undefined,
    });
    profile = ProfileViewSelectors.getProfile(getState());
    expect(profile).toBe(newProfile);

    switchSymbolTable(completeSymbolTable);

    await doSymbolicateProfile(dispatch, profile, symbolStore);
    profile = ProfileViewSelectors.getProfile(getState());

    expect(formatTree(getCallTree(getState()))).toEqual([
      // "overencompassing first symbol" gets split into "first symbol",
      // "second symbol" and "third symbol".
      '- first symbol (total: 2, self: —)',
      '  - last symbol (total: 2, self: 2)',
      '- third symbol (total: 1, self: 1)',
      '- second symbol (total: 1, self: 1)',
    ]);
  });
});

function _createUnsymbolicatedProfile() {
  const { profile } = getProfileFromTextSamples(
    // "0x000a" and "0x0000" are both in the first symbol, and should be merged.
    // See "exampleSymbolTable" for the actual function boundary ranges.
    `
      0x000a  0x0000  0x1a0f  0x0f0f
      0x2000  0x2000
    `
  );
  const thread = profile.threads[0];

  // Add a mock lib.
  const libIndex = 0;
  thread.libs[libIndex] = {
    start: 0,
    end: 0x4000,
    offset: 0,
    arch: '',
    name: 'firefox.exe',
    path: '',
    debugName: 'firefox.pdb',
    debugPath: '',
    breakpadId: '000000000000000000000000000000000',
  };

  thread.resourceTable = {
    length: 1,
    lib: [libIndex],
    name: [thread.stringTable.indexForString('example lib')],
    host: [thread.stringTable.indexForString('example host')],
    type: [resourceTypes.library],
  };
  for (let i = 0; i < thread.funcTable.length; i++) {
    thread.funcTable.resource[i] = 0;
  }
  return profile;
}

function _deleteDatabase(dbName: string) {
  return new Promise((resolve, reject) => {
    const req = fakeIndexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
