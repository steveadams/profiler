/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow

import {
  resourceTypes,
  shallowCloneFuncTable,
  shallowCloneNativeSymbolTable,
} from './data-structures';
import { SymbolsNotFoundError } from './errors';

import type {
  Profile,
  Thread,
  ThreadIndex,
  IndexIntoFuncTable,
  IndexIntoFrameTable,
  IndexIntoResourceTable,
  IndexIntoNativeSymbolTable,
  IndexIntoLibs,
  Address,
} from 'firefox-profiler/types';
import type {
  AbstractSymbolStore,
  AddressResult,
  LibSymbolicationRequest,
} from './symbol-store';

// Contains functions to symbolicate a profile.

/**
 * Symbolication Overview
 *
 * Symbolication is the process of looking up function names for native code and
 * assigning those function names to the functions in the profile.
 *
 * When the profiler samples call stacks for native code, it only collects
 * addresses: the address of the instruction which is currently being executed,
 * and the "return addresses" for its callers on the stack, i.e. the addresses
 * of the instructions that will be executed after each function returns.
 * To obtain a profile with function names, these addresses need to be
 * translated into library-relative offsets, looked up per library, and then
 * substituted with the corresponding function name strings in the profile.
 *
 * The actual lookup of symbols is not handled in this file; it is delegated to
 * an AbstractSymbolStore interface.
 *
 * The functions in this file perform the following tasks:
 *  - assigning addresses to their containing libraries so that they can be
 *    translated into library-relative offsets
 *  - gathering all addresses in the profile which require symbolication,
 *    grouped by library, and requesting symbols from the symbol store
 *  - once the results from the symbol store come in, performing the
 *    substutitions in the profile.
 *
 * Implementation details
 *
 * The implementation has the following constraints:
 *  - Symbolication needs to be asynchronous, and the profile needs to be fully
 *    interactive before symbols have arrived. This means that there needs to
 *    be an intact funcTable from the very start, because the call nodes for
 *    the call tree are based on funcs.
 *  - When the symbols arrive, we cannot mutate the profile in-place. Instead,
 *    we need to delegate the profile mutation to our caller so that it can go
 *    through redux actions and reducers; the profile is part of the redux state
 *    so any profile adjustment needs to follow proper procedure. This allows
 *    all derived data and UI that depends on profile contents to be notified
 *    and updated in the regular ways.
 *    It also allows multiple steps of symbolication to happen in one redux
 *    store update, which saves re-renders if symbol results for many small
 *    libraries arrive at nearly the same time.
 *  - When symbols arrive, the user shouldn't "lose their place" in the call
 *    tree UI; concretely this means that the selected call node and the set of
 *    expanded call nodes should survive symbolication-triggered adjustments of
 *    the funcTable as much as possible. More specifically, if all frames that
 *    used to be assigned to function A get reassigned to function B, we want to
 *    create an A -> B entry in an oldFuncToNewFuncMap that gets dispatched in
 *    a redux action so that the appropriate parts of the redux state can react.
 *  - Multiple processes and threads in the profile will require symbols from
 *    the same set of native libraries, and the number and size of the
 *    symbolication requests for each library should be minimized. This means
 *    that we want to gather all needed addresses across the entire profile
 *    first, rather than requesting symbols separately for each thread.
 *
 * There are two symbolication scenarios: "Initial symbolication" and
 * "re-symbolication". Initial symbolication is the common case: It's kicked off
 * right after converting a Gecko profile into a processed profile.
 * Re-symbolication is the rarer case - it is invoked by an explicit user action,
 * from a button that's hidden away in a panel, and is only necessary if, for
 * some reason, the symbols obtained during initial symbolication were
 * incomplete or otherwise incorrect.
 *
 * Symbolication happens in a number of phases.
 *
 * I. Preparation during profile processing: When native code addresses initially
 * arrive in the Firefox profiler, they come in the form of hex strings in the
 * frame table of the Gecko profile. Profile processing then does the following:
 *  - It detects frames of native code based on the hex string format.
 *  - It looks up the containing library for each address.
 *  - For each native frame, it creates one funcTable entry. It can't really do
 *    any better at this point because it would need to have the symbols in
 *    order to create only one func per actual function. So, to repeat, the
 *    initial funcTable has one func per native frame.
 *    It also creates a nativeSymbols table but leaves it completely empty.
 *  - The frame and its func both get their address field set to the
 *    library-relative offset.
 *  - The func's resource field is set to a resource of type "library" that
 *    points to the lib object in the thread's "libs" list that contained this
 *    address. The frame's and func's address fields are relative to that lib.
 *  - All frames start out with their nativeSymbol field set to null.
 *  - All return addresses are adjusted by subtracting one byte, to point into
 *    the call instruction. See nudgeReturnAddresses for details.
 *
 * II. Address gathering per library: This step goes through all threads and
 * gathers up addresses per library that need to be symbolicated. It also keeps
 * around enough per-thread information so that the per-thread substitution step
 * at the end can perform its work efficiently.
 *
 * III. Symbol lookup: Handled by the AbstractSymbolStore.
 *
 * IV. Symbol result processing: Forwards the symbol lookup result to the caller,
 * expecting a future call to applySymbolicationStep.
 *
 * V. Profile substitution: Invoked from from a thunk action. Processes the
 * symbolication result, groups frame addresses by symbol addresses, finds or
 * creates nativeSymbols for these symbolAddresses, and groups funcs by the
 * function name. At the end, it creates a new thread object with an updated
 * frameTable, funcTable, nativeSymbols and stringTable, with the
 * symbols substituted in the right places. This usually causes many funcs to
 * be orphaned (no frames will use them any more); these orphaned funcs remain
 * in the funcTable. It also creates the oldFuncToNewFuncMap.
 *
 * Re-symbolication only re-runs phases II through V. At the beginning of
 * re-symbolication, the frameTable, funcTable and nativeSymbols are in the
 * state that the previous symbolication left them in. If the previous
 * symbolication merged functions based on an incomplete symbol table, and
 * re-symbolication has a more detailed symbol table with finer-grained function
 * symbols to work with, then re-symbolication needs to split funcs up again.
 * Splitting up funcs means that a collection of frames which were all using the
 * same func before re-symbolication will be assigned to multiple funcs after
 * re-symbolication.
 * This is different to initial symbolication, which usually only needs to
 * *merge* funcs, not split them. That's because the initial profile mosty
 * starts out with a unique func for every frame, except for frames whose
 * address was observed both as a return address and as an instruction pointer
 * value; for those frame addresses there will be two different frames (one with
 * the original address and one with that address minus one byte) which share
 * the same func. Nevertheless, "splitting funcs" is very uncommon during
 * initial symbolication.
 *
 * When funcs are merged, oldFuncToNewFuncMap lets us update other parts of the
 * redux state that refer to func indexes. But when funcs are split, this is not
 * possible. But since function splitting is the rare case, we accept this
 * imperfection.
 *
 * Example for oldFuncToNewFuncMap:
 *
 * Let's say we have a frameTable [0, 1, 2, 3, 4, 5, 6, 7, 8] and all frames are
 * from the same lib. Profile processing creates an initial funcTable with one
 * func per frame: [A, B, C, D, E, F, G, H, I].
 * Now let's say we have two samples with the following frame stacks:
 * 0-1-2-3-4 and 0-1-2-3-7. At the beginning, these are the call paths
 * A-B-C-D-E and A-B-C-D-H. ("Call paths" are stacks that, rather than being
 * made of frames, are made of the frames' corresponding funcs.)
 * The user selects the call node with the call path A-B-C-D-H in the call tree.
 * Now we look up symbols for all frame addresses, and frames 4 and 7 turn out
 * to belong to the same function. We choose function E as the shared function.
 * We update the thread with an oldFuncToNewFuncMap that contains an entry H -> E.
 * This collapses both call paths into the call path A-B-C-D-E, and A-B-C-D-E
 * becomes the selected call node.
 * Now, let's say initial symbolication used an incomplete symbol table that
 * mapped the addresses for frames 0,1,2,3 to one function and 4,5,6,7,8 to
 * another function, so our samples' call paths both become A-A-A-A-E. We update
 * the thread and the selected call path, which is now A-A-A-A-E.
 * Luckily, bad symbols leave the frame addresses intact: Our samples still have
 * the frame stacks 0-1-2-3-4 and 0-1-2-3-7, it's only their corresponding call
 * paths which are A-A-A-A-E.
 * Now we re-symbolicate the profile with a good symbol table, and frames 0 to 3
 * are assigned to different functions again; this time we happened to pick the
 * assignment 0 -> A, 1 -> D, 2 -> B, 3 -> C. So now our samples' call paths
 * become A-D-B-C-E.
 * There is no way to choose oldFuncToNewFuncMap so that the selected call path
 * A-A-A-A-E can become A-D-B-C-E. So in the case of splitting functions we
 * accept that the current selection is lost and that some expanded call nodes
 * will close.
 */

type LibKey = string; // of the form ${debugName}/${breakpadId}

export type SymbolicationStepCallback = (
  threadIndex: ThreadIndex,
  symbolicationStepInfo: SymbolicationStepInfo
) => void;

type ThreadLibSymbolicationInfo = {|
  // The resourceIndex for this lib in this thread.
  resourceIndex: IndexIntoResourceTable,
  // The libIndex for this lib in this thread.
  libIndex: IndexIntoLibs,
  // The set of funcs for this lib in this thread.
  allFuncsForThisLib: Set<IndexIntoFuncTable>,
  // The set of native symbols for this lib in this thread.
  allNativeSymbolsForThisLib: Set<IndexIntoNativeSymbolTable>,
  // All frames for this lib in this thread.
  allFramesForThisLib: Array<IndexIntoFrameTable>,
  // All addresses for frames for this lib in this thread, as lib-relative offsets.
  frameAddresses: Array<Address>,
|};

// This type exists because we symbolicate the profile in steps in order to
// provide a profile to the user faster. This type represents a single step.
export type SymbolicationStepInfo = {|
  threadLibSymbolicationInfo: ThreadLibSymbolicationInfo,
  resultsForLib: Map<Address, AddressResult>,
|};

export type FuncToFuncMap = Map<IndexIntoFuncTable, IndexIntoFuncTable>;

type ThreadSymbolicationInfo = Map<LibKey, ThreadLibSymbolicationInfo>;

/**
 * Like `new Map(iterableOfEntryPairs)`: Creates a map from an iterable of
 * [key, value] pairs. The difference to new Map(...) is what happens if the
 * same key is present multiple times: makeConsensusMap will only contain an
 * entry for a key if the key has the same value in all its uses.
 * In other words, "divergent" entries are removed from the map.
 * Examples:
 *   makeConsensusMap([[1, "hello"], [2, "world"]]) -> 2 entries
 *   makeConsensusMap([[1, "hello"], [2, "world"], [1, "hello"]]) -> 2 entries
 *   makeConsensusMap([[1, "hello"], [2, "world"], [1, "bye"]]) -> 1 entry
 */
function makeConsensusMap<K, V>(
  iterableOfEntryPairs: Iterable<[K, V]>
): Map<K, V> {
  const consensusMap = new Map();
  const divergentKeys = new Set();
  for (const [key, value] of iterableOfEntryPairs) {
    if (divergentKeys.has(key)) {
      continue;
    }
    const previousValue = consensusMap.get(key);
    if (previousValue === undefined) {
      consensusMap.set(key, value);
      continue;
    }
    if (previousValue !== value) {
      consensusMap.delete(key);
      divergentKeys.add(key);
    }
  }
  return consensusMap;
}

/**
 * Gather the symbols needed in this thread, and some auxiliary information that
 * allows the symbol substitation step at the end to work efficiently.
 * Returns a map with one entry for each library resource.
 */
function getThreadSymbolicationInfo(thread: Thread): ThreadSymbolicationInfo {
  const { libs, frameTable, funcTable, nativeSymbols, resourceTable } = thread;

  const map = new Map();
  for (
    let resourceIndex = 0;
    resourceIndex < resourceTable.length;
    resourceIndex++
  ) {
    const resourceType = resourceTable.type[resourceIndex];
    if (resourceType !== resourceTypes.library) {
      continue;
    }
    const libIndex = resourceTable.lib[resourceIndex];
    if (libIndex === null || libIndex === undefined || libIndex === -1) {
      // We can get here if we have pre-symbolicated "funcName (in LibraryName)"
      // frames. Those get resourceTypes.library but no libIndex.
      continue;
    }
    const lib = libs[libIndex];
    if (lib === undefined) {
      throw new Error('Did not find a lib.');
    }

    // Collect the set of funcs for this library in this thread.
    const allFuncsForThisLib = new Set();
    for (let funcIndex = 0; funcIndex < funcTable.length; funcIndex++) {
      if (funcTable.resource[funcIndex] !== resourceIndex) {
        continue;
      }
      allFuncsForThisLib.add(funcIndex);
    }

    // Collect the set of native symbols for this library in this thread.
    const allNativeSymbolsForThisLib = new Set();
    for (
      let nativeSymbolIndex = 0;
      nativeSymbolIndex < nativeSymbols.length;
      nativeSymbolIndex++
    ) {
      if (nativeSymbols.libIndex[nativeSymbolIndex] !== libIndex) {
        continue;
      }
      allNativeSymbolsForThisLib.add(nativeSymbolIndex);
    }

    // Collect the sets of frames and addresses for this library.
    const allFramesForThisLib = [];
    const frameAddresses = [];
    for (let frameIndex = 0; frameIndex < frameTable.length; frameIndex++) {
      const funcIndex = frameTable.func[frameIndex];
      if (funcTable.resource[funcIndex] !== resourceIndex) {
        continue;
      }
      allFramesForThisLib.push(frameIndex);
      frameAddresses.push(frameTable.address[frameIndex]);
    }

    const libKey = `${lib.debugName}/${lib.breakpadId}`;
    map.set(libKey, {
      libIndex,
      resourceIndex,
      allFuncsForThisLib,
      allNativeSymbolsForThisLib,
      allFramesForThisLib,
      frameAddresses,
    });
  }
  return map;
}

// Go through all the threads to gather up the addresses we need to symbolicate
// for each library.
function buildLibSymbolicationRequestsForAllThreads(
  symbolicationInfo: ThreadSymbolicationInfo[]
): LibSymbolicationRequest[] {
  const libKeyToAddressesMap = new Map();
  for (const threadSymbolicationInfo of symbolicationInfo) {
    for (const [libKey, { frameAddresses }] of threadSymbolicationInfo) {
      let addressSet = libKeyToAddressesMap.get(libKey);
      if (addressSet === undefined) {
        addressSet = new Set();
        libKeyToAddressesMap.set(libKey, addressSet);
      }
      for (const frameAddress of frameAddresses) {
        addressSet.add(frameAddress);
      }
    }
  }
  return Array.from(libKeyToAddressesMap).map(([libKey, addresses]) => {
    const [debugName, breakpadId] = libKey.split('/');
    const lib = { debugName, breakpadId };
    return { lib, addresses };
  });
}

// With the symbolication results for the library given by libKey, call
// symbolicationStepCallback for each thread. Those calls will
// ensure that the symbolication information eventually makes it into the thread.
// This function leaves all the actual work to applySymbolicationStep.
function finishSymbolicationForLib(
  profile: Profile,
  symbolicationInfo: ThreadSymbolicationInfo[],
  resultsForLib: Map<Address, AddressResult>,
  libKey: string,
  symbolicationStepCallback: SymbolicationStepCallback
): void {
  const { threads } = profile;
  for (let threadIndex = 0; threadIndex < threads.length; threadIndex++) {
    const threadSymbolicationInfo = symbolicationInfo[threadIndex];
    const threadLibSymbolicationInfo = threadSymbolicationInfo.get(libKey);
    if (threadLibSymbolicationInfo === undefined) {
      continue;
    }
    const symbolicationStep = { threadLibSymbolicationInfo, resultsForLib };
    symbolicationStepCallback(threadIndex, symbolicationStep);
  }
}

/**
 * Apply symbolication to the thread, based on the information that was prepared
 * in symbolicationStepInfo. This involves updating the funcTable to contain the
 * right symbol string and funcAddress, and updating the frameTable to assign
 * frames to the right funcs. When multiple frames are merged into one func,
 * some funcs can become orphaned; they remain in the funcTable.
 * oldFuncToNewFuncMap is mutated to include the new mappings that result from
 * this symbolication step. oldFuncToNewFuncMap is allowed to contain existing
 * content; the existing entries are assumed to be for other libs, i.e. they're
 * expected to have no overlap with allFuncsForThisLib.
 */
export function applySymbolicationStep(
  thread: Thread,
  symbolicationStepInfo: SymbolicationStepInfo,
  oldFuncToNewFuncMap: FuncToFuncMap
): Thread {
  const {
    frameTable: oldFrameTable,
    funcTable: oldFuncTable,
    nativeSymbols: oldNativeSymbols,
    stringTable,
  } = thread;
  const { threadLibSymbolicationInfo, resultsForLib } = symbolicationStepInfo;
  const {
    resourceIndex,
    allFramesForThisLib,
    allFuncsForThisLib,
    allNativeSymbolsForThisLib,
    libIndex,
  } = threadLibSymbolicationInfo;

  const availableFuncs: Set<IndexIntoFuncTable> = new Set(allFuncsForThisLib);
  const availableNativeSymbols: Set<IndexIntoFuncTable> = new Set(
    allNativeSymbolsForThisLib
  );
  const frameToSymbolAddressMap: Map<IndexIntoFrameTable, Address> = new Map();
  const symbolAddressToNameMap: Map<Address, string> = new Map();
  const symbolAddressToCanonicalSymbolIndexMap: Map<
    Address,
    IndexIntoNativeSymbolTable
  > = new Map();

  // We want to group frames into nativeSymbols, and give each nativeSymbol a name.
  // We group frames to the same nativeSymbol if the addresses for these frames resolve
  // to the same symbolAddress.
  // We obtain the funcAddress from the symbolication information in resultsForLib:
  // resultsForLib does not only contain the name of the function; it also contains,
  // for each address, the symbolAddress.
  // All frames with the same symbolAddress are grouped into the same nativeSymbol.
  // Afterwards, we create funcs for symbols with the same name, and then group frames
  // into funcs.
  for (const frameIndex of allFramesForThisLib) {
    const oldFrameSymbol = oldFrameTable.nativeSymbol[frameIndex];
    const address = oldFrameTable.address[frameIndex];
    let addressResult: AddressResult | void = resultsForLib.get(address);
    if (addressResult === undefined) {
      if (oldFrameSymbol !== null) {
        const oldSymbolName = stringTable.getString(
          oldNativeSymbols.name[oldFrameSymbol]
        );
        addressResult = {
          symbolAddress: oldNativeSymbols.address[oldFrameSymbol],
          name: oldSymbolName,
        };
      } else {
        addressResult = {
          symbolAddress: address,
          name: `0x${address.toString(16)}`,
        };
      }
    }

    // |address| is the original frame address that we found during
    // stackwalking, as a library-relative offset.
    // |symbolAddress| is the start of the function, as a library-relative
    // offset.
    const symbolAddress = addressResult.symbolAddress;
    frameToSymbolAddressMap.set(frameIndex, symbolAddress);
    symbolAddressToNameMap.set(symbolAddress, addressResult.name);

    if (oldFrameSymbol !== null) {
      // Opportunistically match up symbolAddress with oldFrameSymbol.
      if (!symbolAddressToCanonicalSymbolIndexMap.has(symbolAddress)) {
        if (availableNativeSymbols.has(oldFrameSymbol)) {
          // Use the frame's old symbol as the canonical symbol for this symbolAddress.
          const newFrameSymbol = oldFrameSymbol;
          availableNativeSymbols.delete(newFrameSymbol);
          symbolAddressToCanonicalSymbolIndexMap.set(
            symbolAddress,
            newFrameSymbol
          );
        } else {
          // oldFrameSymbol has already been used as the canonical symbol for a
          // different symbolAddress. This can happen during re-symbolication.
          // For now, symbolAddressToCanonicalSymbolIndexMap will not contain an
          // entry for this symbolAddress.
          // But that state will be resolved eventually:
          // Either in the course of the rest of this loop (when another frame
          // will donate its oldFrameSymbol), or further down in this function.
        }
      }
    }
  }

  // We now have the symbolAddress for every frame, in frameToSymbolAddressMap.
  // We have also assigned a subset of symbolAddresses to canonical symbols.
  // These symbols have been removed from availableNativeSymbols; availableNativeSymbols
  // contains the subset of existing symbols in the thread that do not have a
  // symbolAddress yet.
  // If this is the initial symbolication, no symbol address will have a canonical
  // symbol because the nativeSymbols table starts out empty.
  // If this is a re-symbolication, then some symbolAddresses may not have
  // a canonical symbol yet, because oldFrameSymbol might already have become
  // the canonical symbol for a different symbolAddress.
  //
  // We need to do the following:
  //  - Find a canonical symbol for every symbolAddress
  //  - give symbols the new name and address
  //  - assign frames to new symbols

  // Find a canonical symbolIndex for any symbolAddress that doesn't have one yet,
  // and give the canonical symbol the right address and symbol.
  const availableNativeSymbolIterator = availableNativeSymbols.values();
  const nativeSymbols = shallowCloneNativeSymbolTable(oldNativeSymbols);
  for (const [symbolAddress, symbolName] of symbolAddressToNameMap) {
    const symbolStringIndex = stringTable.indexForString(symbolName);
    let symbolIndex = symbolAddressToCanonicalSymbolIndexMap.get(symbolAddress);
    if (symbolIndex === undefined) {
      // Repurpose a symbol from availableNativeSymbols as the canonical symbol for this
      // symbolAddress.
      symbolIndex = availableNativeSymbolIterator.next().value;
      if (symbolIndex === undefined) {
        // No existing symbols left. Add a new symbol with the right properties.
        symbolIndex = nativeSymbols.length;
        nativeSymbols.libIndex[symbolIndex] = libIndex;
        // The two other fields willl be filled below.
        nativeSymbols.length++;
      }
      symbolAddressToCanonicalSymbolIndexMap.set(symbolAddress, symbolIndex);
    }
    // Update the symbol properties.
    nativeSymbols.address[symbolIndex] = symbolAddress;
    nativeSymbols.name[symbolIndex] = symbolStringIndex;
  }

  // Now we have a canonical symbol for every symbolAddress.
  // Make a new frameTable with the updated nativeSymbol assignments.
  const newFrameTableNativeSymbolsColumn = oldFrameTable.nativeSymbol.slice();
  for (const [frameIndex, symbolAddress] of frameToSymbolAddressMap) {
    const symbolIndex =
      symbolAddressToCanonicalSymbolIndexMap.get(symbolAddress);
    if (symbolIndex === undefined) {
      throw new Error(
        'Impossible, all symbolAddresses have a canonical symbol at this point.'
      );
    }
    newFrameTableNativeSymbolsColumn[frameIndex] = symbolIndex;
  }

  // Now it is time to look at funcs.
  // For funcs belonging to a native library, we group frames into funcs based
  // on the function name string and the file name. (We don't expect there to
  // be multiple functions with the same name in the same file. If there are,
  // then they'll be treated as the same function.)
  const funcTable = shallowCloneFuncTable(oldFuncTable);
  const availableFuncIter = availableFuncs.values();

  // funcKey -> funcIndex, where funcKey = `${nameStringIndex}:${fileStringIndex}`
  const funcKeyToFuncMap = new Map();

  const oldFuncToNewFuncEntries = [];

  const newFrameTableFuncColumn = oldFrameTable.func.slice();
  const newFrameTableLineColumn = oldFrameTable.line.slice();
  for (const frameIndex of allFramesForThisLib) {
    const oldFunc = oldFrameTable.func[frameIndex];
    const nativeSymbolIndex = newFrameTableNativeSymbolsColumn[frameIndex];
    if (nativeSymbolIndex === null) {
      throw new Error('Impossible, all frames now have native symbols.');
    }
    const address = oldFrameTable.address[frameIndex];
    let addressResult = resultsForLib.get(address);
    if (addressResult === undefined) {
      const symbolName = nativeSymbols.name[nativeSymbolIndex];
      const fileNameIndex = funcTable.fileName[oldFunc];
      addressResult = {
        symbolAddress: nativeSymbols.address[nativeSymbolIndex],
        name: stringTable.getString(symbolName),
        file:
          fileNameIndex !== null
            ? stringTable.getString(fileNameIndex)
            : undefined,
        line: oldFrameTable.line[frameIndex] ?? undefined,
      };
    }
    const functionStringIndex = stringTable.indexForString(addressResult.name);
    const fileNameStringIndex =
      addressResult.file !== undefined
        ? stringTable.indexForString(addressResult.file)
        : null;
    // Group frames into the same function if the have the same function name
    // and the same file.
    const funcKey = `${functionStringIndex}:${fileNameStringIndex ?? ''}`;
    let funcIndex = funcKeyToFuncMap.get(funcKey);
    if (funcIndex === undefined) {
      funcIndex = availableFuncIter.next().value;
      if (funcIndex === undefined) {
        // Need a new func.
        funcIndex = funcTable.length;
        funcTable.isJS[funcIndex] = false;
        funcTable.relevantForJS[funcIndex] = false;
        funcTable.resource[funcIndex] = resourceIndex;
        funcTable.lineNumber[funcIndex] = null;
        funcTable.columnNumber[funcIndex] = null;
        // The name and fileName fields will be filled below.
        funcTable.length++;
      }
      funcTable.name[funcIndex] = functionStringIndex;
      funcTable.fileName[funcIndex] = fileNameStringIndex;
      funcKeyToFuncMap.set(funcKey, funcIndex);
    }

    newFrameTableFuncColumn[frameIndex] = funcIndex;
    newFrameTableLineColumn[frameIndex] = addressResult.line ?? null;
    oldFuncToNewFuncEntries.push([oldFunc, funcIndex]);
  }
  const frameTable = {
    ...oldFrameTable,
    func: newFrameTableFuncColumn,
    nativeSymbol: newFrameTableNativeSymbolsColumn,
    line: newFrameTableLineColumn,
  };

  // Build oldFuncToNewFuncMapForThisLib.
  // If (oldFunc, newFunc) is in oldFuncToNewFuncMapForThisLib, this means
  // that all frames that used to belong to oldFunc have been resolved to
  // the same func newFunc.
  const oldFuncToNewFuncMapForThisLib = makeConsensusMap(
    oldFuncToNewFuncEntries
  );
  for (const [oldFunc, newFunc] of oldFuncToNewFuncMapForThisLib) {
    oldFuncToNewFuncMap.set(oldFunc, newFunc);
  }

  return { ...thread, frameTable, funcTable, nativeSymbols, stringTable };
}

/**
 * Symbolicates the profile. Symbols are obtained from the symbolStore.
 * This function performs steps II-IV (see the comment at the beginning of
 * this file); step V is outsourced to symbolicationStepCallback
 * which can call applySymbolicationStep to complete step V.
 */
export async function symbolicateProfile(
  profile: Profile,
  symbolStore: AbstractSymbolStore,
  symbolicationStepCallback: SymbolicationStepCallback
): Promise<void> {
  const symbolicationInfo = profile.threads.map(getThreadSymbolicationInfo);
  const libSymbolicationRequests =
    buildLibSymbolicationRequestsForAllThreads(symbolicationInfo);
  await symbolStore.getSymbols(
    libSymbolicationRequests,
    (request, results) => {
      const { debugName, breakpadId } = request.lib;
      const libKey = `${debugName}/${breakpadId}`;
      finishSymbolicationForLib(
        profile,
        symbolicationInfo,
        results,
        libKey,
        symbolicationStepCallback
      );
    },
    (request, error) => {
      if (!(error instanceof SymbolsNotFoundError)) {
        // rethrow JavaScript programming error
        throw error;
      }
      // We could not find symbols for this library.
      console.warn(error);
    }
  );
}
