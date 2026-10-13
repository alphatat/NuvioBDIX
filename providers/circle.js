
'use strict';

/*
 * CircleFTP provider for Nuvio
 *
 * Features:
 * - Searches CircleFTP's JSON API.
 * - Fetches post details and uses the direct media URL.
 * - Ranks results by title similarity and year.
 * - Logs to the local console and optionally to your PC's terminal.
 * - Supports movie and title-based TV searches.
 *
 * IMPORTANT:
 * 1. Change DEBUG_URL to your PC's LAN IP.
 * 2. Your server.js must implement POST /__debug.
 * 3. TV season/episode selection is not implemented.
 */

var BASE_URL = 'http://new.circleftp.net';
var API_URL = 'http://new.circleftp.net:5000/api/posts';
var PROVIDER_NAME = 'CircleFTP';

// Change this to your PC's LAN IP.
// Set to an empty string to disable remote terminal logging.
var DEBUG_URL = 'http://192.168.8.40:3000/__debug';

function debugLog(message) {
  // var text = '[CircleFTP] ' + String(message);

  // try {
  //   console.log(text);
  // } catch (_) {}

  // if (!DEBUG_URL) return;

  // try {
  //   fetch(DEBUG_URL, {
  //     method: 'POST',
  //     headers: {
  //       'Content-Type': 'text/plain'
  //     },
  //     body: text
  //   }).catch(function () {});
  // } catch (_) {
  //   // Logging failures must not interrupt stream discovery.
  // }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripTags(value) {
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize ? String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
    : String(value || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
}

function getYear(value) {
  var match = String(value || '').match(/\b(19\d{2}|20\d{2})\b/);
  return match ? match[1] : '';
}

function getPostTitle(post) {
  return String(
    post.name ||
    post.title ||
    ''
  ).trim();
}

function getPostYear(post) {
  return String(post.year || getYear(post.title) || '').trim();
}

function titleSimilarity(query, candidate) {
  var a = normalizeTitle(query);
  var b = normalizeTitle(candidate);

  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.indexOf(a) !== -1) return 80;
  if (a.indexOf(b) !== -1) return 70;

  var aWords = a.split(/\s+/);
  var bWords = b.split(/\s+/);
  var matches = 0;

  for (var i = 0; i < aWords.length; i++) {
    if (bWords.indexOf(aWords[i]) !== -1) matches++;
  }

  return Math.round(60 * matches / Math.max(aWords.length, 1));
}

function scorePost(post, queryTitle, requestedYear) {
  var name = getPostTitle(post);
  var title = String(post.title || '');
  var score = Math.max(
    titleSimilarity(queryTitle, name),
    titleSimilarity(queryTitle, title)
  );

  var postYear = getPostYear(post);

  if (requestedYear && postYear) {
    if (requestedYear === postYear) {
      score += 20;
    } else {
      score -= 25;
    }
  }

  return score;
}

function selectBestPost(posts, queryTitle, requestedYear) {
  if (!posts.length) return null;

  var ranked = posts.map(function (post) {
    return {
      post: post,
      score: scorePost(post, queryTitle, requestedYear)
    };
  });

  ranked.sort(function (a, b) {
    return b.score - a.score;
  });

  debugLog(
    'Best match: ' +
    getPostTitle(ranked[0].post) +
    ' (score ' + ranked[0].score + ')'
  );

  // Avoid returning an obviously unrelated search result.
  if (ranked[0].score < 15) {
    debugLog('No sufficiently relevant result found.');
    return null;
  }

  return ranked[0].post;
}

/*
 * When Nuvio passes a title explicitly, use it.
 * When it passes title metadata as an object, prefer original_title
 * or original_name if available.
 *
 * A numeric TMDB ID alone cannot reliably provide the original title
 * without TMDB API access. The webpage fallback below requests English.
 */
function titleFromTmdbPage(tmdbId, mediaType) {
  var type = mediaType === 'tv' ? 'tv' : 'movie';
  var url = 'https://www.themoviedb.org/' +
    type + '/' + encodeURIComponent(String(tmdbId)) +
    '?language=en-US';

  debugLog('Looking up TMDB title: ' + tmdbId);

  return fetch(url, {
    headers: {
      'Accept': 'text/html',
      'User-Agent': 'Mozilla/5.0 (compatible; Nuvio CircleFTP provider)'
    }
  }).then(function (response) {
    if (!response.ok) {
      throw new Error('TMDB title lookup returned HTTP ' + response.status);
    }

    return response.text();
  }).then(function (html) {
    // Try original-title fields if TMDB exposes them in embedded JSON.
    var patterns = mediaType === 'tv'
      ? [
          /"original_name"\s*:\s*"((?:\\.|[^"\\])*)"/,
          /"originalName"\s*:\s*"((?:\\.|[^"\\])*)"/
        ]
      : [
          /"original_title"\s*:\s*"((?:\\.|[^"\\])*)"/,
          /"originalTitle"\s*:\s*"((?:\\.|[^"\\])*)"/
        ];

    for (var i = 0; i < patterns.length; i++) {
      var match = html.match(patterns[i]);

      if (match && match[1]) {
        try {
          var original = JSON.parse('"' + match[1] + '"');
          if (original.trim()) {
            debugLog('Found original title metadata: ' + original);
            return original.trim();
          }
        } catch (_) {}
      }
    }

    // Fallback: Open Graph title.
    var og = html.match(
      /<meta\b[^>]*\bproperty=["']og:title["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i
    );

    var title = og ? stripTags(og[1]) : '';

    if (!title) {
      var reverseOg = html.match(
        /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:title["'][^>]*>/i
      );

      title = reverseOg ? stripTags(reverseOg[1]) : '';
    }

    title = title.replace(/\s*[|–—·-]\s*The Movie Database.*$/i, '').trim();

    if (!title) {
      throw new Error('Could not extract a title from TMDB');
    }

    debugLog('Using TMDB page title: ' + title);
    return title;
  });
}

function getQueryTitle(tmdbId, mediaType, season, episode, extraTitle) {
  if (typeof extraTitle === 'string' && extraTitle.trim()) {
    return Promise.resolve(extraTitle.trim());
  }

  if (tmdbId && typeof tmdbId === 'object') {
    var objectTitle =
      tmdbId.original_title ||
      tmdbId.original_name ||
      tmdbId.title ||
      tmdbId.name;

    if (objectTitle) {
      return Promise.resolve(String(objectTitle).trim());
    }

    tmdbId =
      tmdbId.id ||
      tmdbId.tmdbId ||
      tmdbId.tmdb_id;
  }

  if (
    typeof tmdbId === 'string' &&
    tmdbId.trim() &&
    !/^\d+$/.test(tmdbId.trim())
  ) {
    return Promise.resolve(tmdbId.trim());
  }

  if (tmdbId === undefined || tmdbId === null || tmdbId === '') {
    return Promise.reject(new Error('No title or TMDB ID supplied'));
  }

  return titleFromTmdbPage(tmdbId, mediaType);
}

function searchPosts(queryTitle) {
  var url = API_URL +
    '?searchTerm=' + encodeURIComponent(queryTitle) +
    '&order=desc';

  debugLog('Searching: ' + queryTitle);
  debugLog('Search URL: ' + url);

  return fetch(url, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Referer': BASE_URL + '/'
    }
  }).then(function (response) {
    if (!response.ok) {
      throw new Error('Search API returned HTTP ' + response.status);
    }

    return response.json();
  }).then(function (data) {
    var posts = data && Array.isArray(data.posts) ? data.posts : [];

    debugLog('Search returned ' + posts.length + ' posts');

    return posts;
  });
}

function getPostDetails(postId) {
  var url = API_URL + '/' + encodeURIComponent(String(postId));

  debugLog('Fetching post details: ' + postId);

  return fetch(url, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Referer': BASE_URL + '/'
    }
  }).then(function (response) {
    if (!response.ok) {
      throw new Error('Post details API returned HTTP ' + response.status);
    }

    return response.json();
  });
}

function isValidMediaUrl(url) {
  return typeof url === 'string' &&
    /^https?:\/\//i.test(url.trim()) &&
    /\.(mkv|mp4|m4v|webm|avi|mov)(?:$|[?#])/i.test(url.trim());
}

function buildStream(details, queryTitle) {
  var mediaUrl = String(details.content || '').trim();

  if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
    debugLog('Post ' + details.id + ' has no valid HTTP(S) content URL.');
    return null;
  }

  debugLog('Stream URL found for post ' + details.id);
  debugLog('Media URL: ' + mediaUrl);

  return {
    name: PROVIDER_NAME,
    title: details.title || details.name || queryTitle,
    url: mediaUrl,
    quality: details.quality || 'Unknown',
    headers: {
      'Referer': BASE_URL + '/',
      'User-Agent': 'Mozilla/5.0 (compatible; Nuvio CircleFTP provider)'
    }
  };
}

function getStreams(tmdbId, mediaType, season, episode, title) {
  if (mediaType === 'tv') {
    debugLog(
      'TV search is title-based; season and episode matching ' +
      'are not implemented in this version.'
    );
  }

  return getQueryTitle(
    tmdbId,
    mediaType,
    season,
    episode,
    title
  ).then(function (queryTitle) {
    queryTitle = String(queryTitle || '').trim();

    if (!queryTitle) {
      throw new Error('Resolved title is empty');
    }

    var requestedYear = getYear(queryTitle);

    return searchPosts(queryTitle).then(function (posts) {
      if (!posts.length) {
        debugLog('No search results for: ' + queryTitle);
        return [];
      }

      var selected = selectBestPost(
        posts,
        queryTitle,
        requestedYear
      );

      if (!selected) return [];

      debugLog(
        'Selected post ' + selected.id + ': ' +
        (selected.title || selected.name || '(untitled)')
      );

      return getPostDetails(selected.id).then(function (details) {
        var stream = buildStream(details, queryTitle);

        if (!stream) return [];

        return [stream];
      });
    });
  }).catch(function (error) {
    debugLog(
      'ERROR: ' +
      (error && error.message ? error.message : String(error))
    );

    return [];
  });
}

module.exports = {
  getStreams: getStreams
};
