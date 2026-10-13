
'use strict';

/*
 * CircleFTP provider for Nuvio
 *
 * Movies:
 *   GET /api/posts?searchTerm=TITLE&order=desc
 *   GET /api/posts/POST_ID
 *   details.content -> direct media URL
 *
 * TV:
 *   Searches the same API, selects a series post, then reads:
 *   details.content[].episodes[].link
 *
 * Remote logging:
 *   Set DEBUG_URL to your PC's LAN IP.
 */

var BASE_URL = 'http://new.circleftp.net';
var API_URL = 'http://new.circleftp.net:5000/api/posts';
var PROVIDER_NAME = 'CircleFTP';

// Change this to your PC's LAN IP. Use '' to disable remote logging.
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
  //     headers: { 'Content-Type': 'text/plain' },
  //     body: text
  //   }).catch(function () {});
  // } catch (_) {}
}

function normalizeTitle(value) {
  var text = String(value || '');

  try {
    text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  } catch (_) {}

  return text.toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getYear(value) {
  var match = String(value || '').match(/\b(19\d{2}|20\d{2})\b/);
  return match ? match[1] : '';
}

function getPostTitle(post) {
  return String(post.name || post.title || '').trim();
}

function titleSimilarity(query, candidate) {
  var a = normalizeTitle(query);
  var b = normalizeTitle(candidate);

  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.indexOf(a) !== -1) return 85;
  if (a.indexOf(b) !== -1) return 75;

  var aWords = a.split(/\s+/);
  var bWords = b.split(/\s+/);
  var matches = 0;

  for (var i = 0; i < aWords.length; i++) {
    if (bWords.indexOf(aWords[i]) !== -1) matches++;
  }

  return Math.round(60 * matches / Math.max(aWords.length, 1));
}

function scorePost(post, queryTitle, requestedYear, mediaType) {
  var title = getPostTitle(post);
  var score = Math.max(
    titleSimilarity(queryTitle, title),
    titleSimilarity(queryTitle, post.title || '')
  );

  var postYear = String(post.year || getYear(post.title) || '');

  if (requestedYear && postYear) {
    score += requestedYear === postYear ? 20 : -25;
  }

  // Prefer series posts for TV requests and single-video posts for movies.
  if (mediaType === 'tv') {
    if (post.type === 'series') score += 30;
    else score -= 25;
  } else {
    if (post.type === 'singleVideo') score += 10;
    else if (post.type === 'series') score -= 30;
  }

  return score;
}

function selectBestPost(posts, queryTitle, requestedYear, mediaType) {
  if (!posts.length) return null;

  var ranked = posts.map(function (post) {
    return {
      post: post,
      score: scorePost(post, queryTitle, requestedYear, mediaType)
    };
  });

  ranked.sort(function (a, b) {
    return b.score - a.score;
  });

  debugLog(
    'Best match: ' + getPostTitle(ranked[0].post) +
    ' (score ' + ranked[0].score + ', type ' +
    ranked[0].post.type + ')'
  );

  if (ranked[0].score < 15) {
    debugLog('No sufficiently relevant result found.');
    return null;
  }

  return ranked[0].post;
}

function titleFromTmdbPage(tmdbId, mediaType) {
  var type = mediaType === 'tv' ? 'tv' : 'movie';
  var url = 'https://www.themoviedb.org/' + type + '/' +
    encodeURIComponent(String(tmdbId)) + '?language=en-US';

  debugLog('Looking up TMDB title: ' + tmdbId);

  return fetch(url).then(function (response) {
    if (!response.ok) {
      throw new Error('TMDB returned HTTP ' + response.status);
    }
    return response.text();
  }).then(function (html) {
    // Try the original title/name in embedded page metadata first.
    var patterns = mediaType === 'tv'
      ? [/"original_name"\s*:\s*"((?:\\.|[^"\\])*)"/]
      : [/"original_title"\s*:\s*"((?:\\.|[^"\\])*)"/];

    for (var i = 0; i < patterns.length; i++) {
      var match = html.match(patterns[i]);

      if (match) {
        try {
          var original = JSON.parse('"' + match[1] + '"');
          if (original.trim()) return original.trim();
        } catch (_) {}
      }
    }

    // Fallback to the page title. This may be localized.
    var og = html.match(
      /<meta\b[^>]*\bproperty=["']og:title["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i
    );

    var title = og ? og[1] : '';
    title = title.replace(/&amp;/gi, '&')
      .replace(/\s*[|–—·-]\s*The Movie Database.*$/i, '')
      .trim();

    if (!title) throw new Error('Could not extract TMDB title');

    debugLog('Using TMDB page title fallback: ' + title);
    return title;
  });
}

function getQueryTitle(tmdbId, mediaType, season, episode, extraTitle) {
  if (typeof extraTitle === 'string' && extraTitle.trim()) {
    return Promise.resolve(extraTitle.trim());
  }

  if (tmdbId && typeof tmdbId === 'object') {
    var objectTitle = tmdbId.original_title ||
      tmdbId.original_name ||
      tmdbId.title ||
      tmdbId.name;

    if (objectTitle) return Promise.resolve(String(objectTitle).trim());

    tmdbId = tmdbId.id || tmdbId.tmdbId || tmdbId.tmdb_id;
  }

  if (typeof tmdbId === 'string' &&
      tmdbId.trim() && !/^\d+$/.test(tmdbId.trim())) {
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
  return fetch(API_URL + '/' + encodeURIComponent(String(postId)), {
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

function findSeason(content, requestedSeason) {
  if (!Array.isArray(content)) return null;

  var target = Number(requestedSeason);
  if (!Number.isFinite(target) || target < 1) target = 1;

  for (var i = 0; i < content.length; i++) {
    var season = content[i];
    var seasonName = String(season.seasonName || '');
    var match = seasonName.match(/season\s*(\d+)/i);

    if (match && Number(match[1]) === target) return season;
  }

  // Some APIs omit season numbers in their names.
  if (content.length === 1 && !content[0].seasonName) {
    return content[0];
  }

  return null;
}

function findEpisode(season, requestedEpisode) {
  if (!season || !Array.isArray(season.episodes)) return null;

  var target = Number(requestedEpisode);
  if (!Number.isFinite(target) || target < 1) target = 1;

  // Prefer the episode's explicit title, e.g. S1E2 or S01E02.
  for (var i = 0; i < season.episodes.length; i++) {
    var item = season.episodes[i];
    var title = String(item.title || '');

    var match = title.match(/\bS\d+\s*E(\d+)\b/i) ||
      title.match(/\bE(?:pisode)?\s*(\d+)\b/i);

    if (match && Number(match[1]) === target) return item;
  }

  // Fallback: episode order within the season.
  return season.episodes[target - 1] || null;
}

function makeMovieStream(details, queryTitle) {
  var url = String(details.content || '').trim();

  if (!/^https?:\/\//i.test(url)) {
    debugLog('Movie post has no direct media URL.');
    return [];
  }

  return [{
    name: details.title || PROVIDER_NAME,
    title: details.title || details.name || queryTitle,
    url: url,
    quality: details.quality || 'Unknown',
    headers: {
      'Referer': BASE_URL + '/',
      'User-Agent': 'Mozilla/5.0 (compatible; Nuvio CircleFTP provider)'
    }
  }];
}

function makeTvStream(details, queryTitle, seasonNumber, episodeNumber) {
  var seasons = details.content;

  if (!Array.isArray(seasons)) {
    debugLog('TV post content is not a season array.');
    return [];
  }

  var season = findSeason(seasons, seasonNumber);

  if (!season) {
    debugLog('Season ' + seasonNumber + ' not found.');
    return [];
  }

  var episode = findEpisode(season, episodeNumber);

  if (!episode) {
    debugLog(
      'Episode ' + episodeNumber + ' not found in ' +
      (season.seasonName || 'requested season') + '.'
    );
    return [];
  }

  var url = String(episode.link || '').trim();

  if (!/^https?:\/\//i.test(url)) {
    debugLog('Episode has no valid direct media URL.');
    return [];
  }

  debugLog(
    'Selected ' + (season.seasonName || 'season ' + seasonNumber) +
    ', episode ' + episodeNumber + ': ' + episode.title
  );

  return [{
    name: episode.title || PROVIDER_NAME,
    title: episode.title ||
      (details.name || queryTitle) +
      ' S' + seasonNumber + 'E' + episodeNumber,
    url: url,
    quality: details.quality || 'Unknown',
    headers: {
      'Referer': BASE_URL + '/',
      'User-Agent': 'Mozilla/5.0 (compatible; Nuvio CircleFTP provider)'
    }
  }];
}


function getMovieStreams(posts, queryTitle) {
  // Rank results by title similarity, then keep multiple plausible matches.
  var requestedYear = getYear(queryTitle);

  var ranked = posts.map(function (post) {
    return {
      post: post,
      score: scorePost(post, queryTitle, requestedYear, 'movie')
    };
  });

  ranked.sort(function (a, b) {
    return b.score - a.score;
  });

  // Avoid returning unrelated results.
  ranked = ranked.filter(function (item) {
    return item.score >= 15 &&
      item.post.type !== 'series';
  });

  debugLog('Matching movie results: ' + ranked.length);

  // Resolve the details for each matching movie.
  return Promise.all(ranked.map(function (item) {
    return getPostDetails(item.post.id).then(function (details) {
      return makeMovieStream(details, queryTitle);
    }).catch(function (error) {
      debugLog(
        'Failed to load movie ' + item.post.id + ': ' +
        (error.message || String(error))
      );
      return [];
    });
  })).then(function (results) {
    return results.reduce(function (all, streams) {
      return all.concat(streams);
    }, []);
  });
}

function getStreams(tmdbId, mediaType, season, episode, title) {
  var isTv = mediaType === 'tv';

  return getQueryTitle(
    tmdbId, mediaType, season, episode, title
  ).then(function (queryTitle) {
    queryTitle = String(queryTitle || '').trim();

    if (!queryTitle) {
      throw new Error('Resolved title is empty');
    }

    debugLog('Searching title: ' + queryTitle);

    return searchPosts(queryTitle).then(function (posts) {
      if (!posts.length) {
        debugLog('No results for: ' + queryTitle);
        return [];
      }

      if (!isTv) {
        // Movies: return every plausible matching result.
        return getMovieStreams(posts, queryTitle);
      }

      // TV: retain the existing single-series/single-episode behavior.
      var requestedYear = getYear(queryTitle);
      var selected = selectBestPost(
        posts, queryTitle, requestedYear, mediaType
      );

      if (!selected) return [];

      debugLog('Selected TV post ID: ' + selected.id);

      return getPostDetails(selected.id).then(function (details) {
        return makeTvStream(
          details,
          queryTitle,
          season,
          episode
        );
      });
    });
  }).catch(function (error) {
    debugLog('ERROR: ' + (
      error && error.message ? error.message : String(error)
    ));
    return [];
  });
}


module.exports = {
  getStreams: getStreams
};
