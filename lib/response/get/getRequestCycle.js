var checkCacheAndReport = require("./checkCacheAndReport");
var MaxRetryExceededError = require("./../../errors/MaxRetryExceededError");
var fastCat = require("./../../get/util/support").fastCat;
var collectLru = require("./../../lru/collect");
var getSize = require("./../../support/getSize");
var AssignableDisposable = require("./../AssignableDisposable");
var InvalidSourceError = require("../../errors/InvalidSourceError");

function h(x) {
    var hash = 0;
    var s = JSON.stringify(x);
    if (s.length === 0) {
        return hash;
    }
    for (var i = 0; i < s.length; i++) {
        var char = s.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash)
        .toString(16)
        .toUpperCase();
}

/**
 * The get request cycle for checking the cache and reporting
 * values.  If there are missing paths then the async request cycle to
 * the data source is performed until all paths are resolved or max
 * requests are made.
 * @param {GetResponse} getResponse -
 * @param {Model} model - The model that the request was made with.
 * @param {Object} results -
 * @param {Function} onNext -
 * @param {Function} onError -
 * @param {Function} onCompleted -
 * @private
 */
module.exports = function getRequestCycle(
    getResponse,
    model,
    results,
    observer,
    errors,
    count
) {
    // we have exceeded the maximum retry limit.
    if (count > model._maxRetries) {
        observer.onError(
            new MaxRetryExceededError(results.optimizedMissingPaths)
        );
        return {
            dispose: function() {}
        };
    }

    var requestQueue = model._request;
    var requestedMissingPaths = results.requestedMissingPaths;
    var optimizedMissingPaths = results.optimizedMissingPaths;
    var disposable = new AssignableDisposable();

    // We need to prepend the bound path to all requested missing paths and
    // pass those into the requestQueue.
    var boundRequestedMissingPaths = [];
    var boundPath = model._path;
    if (boundPath.length) {
        for (var i = 0, len = requestedMissingPaths.length; i < len; ++i) {
            boundRequestedMissingPaths[i] = fastCat(
                boundPath,
                requestedMissingPaths[i]
            );
        }
    }

    // No bound path, no array copy and concat.
    else {
        boundRequestedMissingPaths = requestedMissingPaths;
    }

    var currentRequestDisposable = requestQueue.get(
        boundRequestedMissingPaths,
        optimizedMissingPaths,
        count,
        function(err, data, hasInvalidatedResult) {
            if (err) {
                console.error( "xxxx rq-get failed " + count + " " + h(optimizedMissingPaths) + " " + JSON.stringify(optimizedMissingPaths));
            }

            if (
                model._treatDataSourceErrorsAsJSONGraphErrors
                    ? err instanceof InvalidSourceError
                    : !!err
            ) {
                if (results.hasValues) {
                    observer.onNext(results.values && results.values[0]);
                }
                observer.onError(err);
                return;
            }

            var nextRequestedMissingPaths;
            var nextSeed;

            // If merging over an existing branch structure with refs has invalidated our intermediate json,
            // we want to start over and re-get all requested paths with a fresh seed
            if (hasInvalidatedResult) {
                nextRequestedMissingPaths = getResponse.currentRemainingPaths;
                nextSeed = [{}];
            } else {
                nextRequestedMissingPaths = requestedMissingPaths;
                nextSeed = results.values;
            }

            // Once the request queue finishes, check the cache and bail if
            // we can.
            var nextResults = checkCacheAndReport(
                model,
                nextRequestedMissingPaths,
                observer,
                getResponse.isProgressive,
                getResponse.isJSONGraph,
                nextSeed,
                errors
            );

            // If there are missing paths coming back form checkCacheAndReport
            // the its reported from the core cache check method.
            if (nextResults) {
                console.error( "xxxx retrying " + (count + 1) + " " + h(nextResults.requestedMissingPaths));

                // update the which disposable to use.
                disposable.currentDisposable = getRequestCycle(
                    getResponse,
                    model,
                    nextResults,
                    observer,
                    errors,
                    count + 1
                );
            }

            // We have finished.  Since we went to the dataSource, we must
            // collect on the cache.
            else {
                if (err) {
                    console.error("xxxx err but no retry " + (count + 1) + " " + h(nextResults.requestedMissingPaths));
                }

                var modelRoot = model._root;
                var modelCache = modelRoot.cache;
                var currentVersion = modelCache.$_version;

                collectLru(
                    modelRoot,
                    modelRoot.expired,
                    getSize(modelCache),
                    model._maxSize,
                    model._collectRatio,
                    currentVersion
                );
            }
        }
    );
    disposable.currentDisposable = currentRequestDisposable;
    return disposable;
};
