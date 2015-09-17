// Licensed to Cloudera, Inc. under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  Cloudera, Inc. licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var SQL_TERMS = /\b(FROM|TABLE|STATS|REFRESH|METADATA|DESCRIBE|ORDER BY|ON|WHERE|SELECT|LIMIT|GROUP|SORT)\b/g;
var TIME_TO_LIVE_IN_MILLIS = 86400000; // 1 day

/**
 * @param options {object}
 * @param options.db
 * @param options.mode
 * @param options.assistHelper
 *
 * @constructor
 */
function Autocompleter(options) {
  var self = this;
  self.options = options;
  self.assistHelper = options.assistHelper;
  if (typeof options.mode === "undefined" || options.mode === null || options.mode === "beeswax") {
    self.currentMode = "hive";
  } else {
    self.currentMode = options.mode;
  }

  huePubSub.subscribe('hue.ace.activeMode', function(mode) {
    self.currentMode = mode.split("/").pop();
  })
}

Autocompleter.prototype.getTableReferenceIndex = function (statement) {
  var result = {};
  var fromMatch = statement.match(/\s*from\s*([^;]*).*$/i);
  if (fromMatch) {
    var tableRefsRaw = fromMatch[1];
    upToMatch = tableRefsRaw.match(/\bON|LIMIT|WHERE|GROUP|SORT|ORDER BY\b/i);
    if (upToMatch) {
      tableRefsRaw = $.trim(tableRefsRaw.substring(0, upToMatch.index));
    }
    var tableRefs = tableRefsRaw.split(",");
    tableRefs.sort();
    $.each(tableRefs, function(index, tableRefRaw) {
      var tableMatch = tableRefRaw.match(/ *([^ ]*) ?([^ ]*)? */);
      result[tableMatch[2] || tableMatch[1]] = tableMatch[1];
    })
  }
  return result;
};

Autocompleter.prototype.extractFields = function (data, valuePrefix, includeStar) {
  var fields = [];
  var result = [];

  if (data.type == "struct") {
    fields = $.map(data.fields, function(field) {
      return {
        name: field.name,
        type: field.type
      };
    });
  } else if (typeof data.columns != "undefined") {
    fields = $.map(data.columns, function(column) {
      return {
        name: column,
        type: "column"
      }
    });
    if (includeStar) {
      result.push({value: '*', score: 10000, meta: "column"});
    }
  } else if (typeof data.tables != "undefined") {
    fields = $.map(data.tables, function(table) {
      return {
        name: table,
        type: "table"
      }
    });
  }

  fields.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });

  fields.forEach(function(field, idx) {
    if (field.name != "") {
      result.push({value: typeof valuePrefix != "undefined" ? valuePrefix + field.name : field.name, score: 1000 - idx, meta: field.type});
    }
  });
  return result;
};

Autocompleter.prototype.autocomplete = function(beforeCursor, afterCursor, callback) {
  var onFailure = function() {
    callback([]);
  };

  var self = this;

  if (typeof self.assistHelper.activeDatabase() == "undefined"
    || self.assistHelper.activeDatabase() == null
    || self.assistHelper.activeDatabase() == ""
    || (self.currentMode !== "hive" && self.currentMode !== "impala")) {
    onFailure();
    return;
  }

  var beforeCursorU = beforeCursor.toUpperCase();
  var afterCursorU = afterCursor.toUpperCase();

  var beforeMatcher = beforeCursorU.match(SQL_TERMS);
  var afterMatcher = afterCursorU.match(SQL_TERMS);

  var tableNameAutoComplete = beforeMatcher != null && (
    beforeMatcher[beforeMatcher.length - 1] === "FROM" ||
    beforeMatcher[beforeMatcher.length - 1] === "TABLE" ||
    beforeMatcher[beforeMatcher.length - 1] === "STATS" ||
    beforeMatcher[beforeMatcher.length - 1] === "REFRESH" ||
    beforeMatcher[beforeMatcher.length - 1] === "METADATA" ||
    beforeMatcher[beforeMatcher.length - 1] === "DESCRIBE");

  var selectBefore = beforeMatcher != null &&
    beforeMatcher[beforeMatcher.length - 1] === "SELECT";

  var fromAfter = afterMatcher != null &&
    afterMatcher[0] === "FROM";

  var fieldTermBefore = beforeMatcher != null && (
    beforeMatcher[beforeMatcher.length - 1] === "WHERE" ||
    beforeMatcher[beforeMatcher.length - 1] === "ON" ||
    beforeMatcher[beforeMatcher.length - 1] === "ORDER BY");


  if (tableNameAutoComplete || (selectBefore && !fromAfter)) {
    self.assistHelper.fetchTables(function(data) {
      var fromKeyword = "";
      if (selectBefore) {
        if (beforeCursor.indexOf("SELECT") > -1) {
          fromKeyword = "FROM";
        } else {
          fromKeyword = "from";
        }
        if (beforeCursor.match(/select\s*$/i)) {
          fromKeyword = "? " + fromKeyword;
        }
        if (!beforeCursor.match(/(\s+|f|fr|fro|from)$/)) {
          fromKeyword = " " + fromKeyword;
        }
        fromKeyword += " ";
      }
      callback(self.extractFields(data, fromKeyword));
    }, onFailure );
  } else if ((selectBefore && fromAfter) || fieldTermBefore) {
    var partialTermsMatch = beforeCursor.match(/([^ \-\+\<\>\,]*)$/);
    var parts = partialTermsMatch ? partialTermsMatch[0].split(".") : [];

    if (parts.length > 0 && parts[parts.length - 1] != '') {
      // SELECT tablename.colu
      parts.pop();
    }

    var tableReferences = self.getTableReferenceIndex(beforeCursor + afterCursor);
    var tableName = "";
    if (parts.length > 0 && tableReferences[parts[0]]) {
      // SELECT tablename.column.
      tableName = tableReferences[parts[0]];
      parts.shift();
    } else if (Object.keys(tableReferences).length == 1) {
      // SELECT column.
      // We use first and only table reference
      tableName = tableReferences[Object.keys(tableReferences)[0]];
    } else if (Object.keys(tableReferences).length > 1) {
      callback($.map(Object.keys(tableReferences), function(key, idx) {
        return { value: key + ".", score: 1000 - idx, meta: tableReferences[key] == key ? 'table' : 'alias' };
      }));
      return;
    } else {
      // No table refs
      onFailure();
      return;
    }

    var getFields = function (remainingParts, fields) {
      if (remainingParts.length == 0) {
        self.assistHelper.fetchFields(tableName, fields, function(data) {
          callback(self.extractFields(data, "", !fieldTermBefore));
        }, onFailure);
        return; // break recursion
      }
      var part = remainingParts.shift();

      if (part != '' && part !== tableName) {
        if (self.currentMode === "hive") {
          var mapOrArrayMatch = part.match(/([^\[]*)\[[^\]]*\]$/i);
          if (mapOrArrayMatch !== null) {
            fields.push(mapOrArrayMatch[1]);
            self.assistHelper.fetchFields(tableName, fields, function(data) {
              if (data.type === "map") {
                fields.push("value");
                getFields(remainingParts, fields);
              } else if (data.type === "array") {
                fields.push("item");
                getFields(remainingParts, fields);
              } else {
                onFailure();
              }
            }, onFailure);
            return; // break recursion, it'll be async above
          }
        }
        fields.push(part);
      }
      getFields(remainingParts, fields);
    };

    getFields(parts, []);
  } else {
    onFailure();
  }
};