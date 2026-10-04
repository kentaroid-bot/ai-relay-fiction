/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as desk from "../desk.js";
import type * as intake from "../intake.js";
import type * as intakeWorker from "../intakeWorker.js";
import type * as forest from "../forest.js";
import type * as http from "../http.js";
import type * as policy from "../policy.js";
import type * as safety from "../safety.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  desk: typeof desk;
  intake: typeof intake;
  intakeWorker: typeof intakeWorker;
  forest: typeof forest;
  http: typeof http;
  policy: typeof policy;
  safety: typeof safety;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
