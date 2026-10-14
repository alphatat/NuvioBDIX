
'use strict';

/*
 * CircleFTP provider for Nuvio TV
 *
 * Movies:
 *   Search CircleFTP and return all non-series results
 *   in the exact order returned by its API.
 *
 * TV:
 *   Select the first series result and return the
 *   requested season/episode stream.
 *
 * Nuvio interface:
 *   getStreams(tmdbId, mediaType, season, episode)
 */

var PROVIDER_NAME = 'CircleFTP';
var BASE_URL = 'http://new.circleftp.net';
var API_URL = 'http://new.circleftp.net:5000/api/posts';

/* -------------------- Logging -------------------- */

function log(message) {
  try {
    console.log('[CircleFTP] ' + String(message));
  } catch (_) {}
}

/* -------------------- Media type -------------------- */

function isTvType(mediaType) {
  var type = String(mediaType || '').toLowerCase();

  return type === 'tv' ||
    type === 'series' ||
    type === 'show' ||
    type === 'anime';
}

/* -------------------- Title helpers -------------------- */

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function titleFromTmdbPage(tmdbId, mediaType) {
  var type = isTvType(mediaType) ? 'tv' : 'movie';
  var url = 'https://www.themoviedb.org/' +
    type + '/' + encodeURIComponent(String(tmdbId)) +
    '?language=en-US';

  log('Resolving title from TMDB: ' + url);

  return fetch(url).then(function (response) {
    if (!response.ok) {
      throw new Error('TMDB HTTP ' + response.status);
    }

    return response.text();
  }).then(function (html) {
    var property = type === 'tv'
      ? 'original_name'
      : 'original_title';

    var pattern = new RegExp(
      '"' + property + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"'
    );

    var match = html.match(pattern);

    if (match) {
      try {
        var originalTitle = JSON.parse('"' + match[1] + '"');

        if (originalTitle && originalTitle.trim()) {
          log('Original title: ' + originalTitle);
          return originalTitle.trim();
        }
      } catch (_) {}
    }

    // Fallback: the page's Open Graph title.
    // This fallback might be localized.
    var ogMatch = html.match(
      /<meta\b(?=[^>]*\bproperty=["']og:title["'])(?=[^>]*\bcontent=["']([^"']+)["'])[^>]*>/i
    );

    if (ogMatch && ogMatch[1]) {
      var fallback = decodeHtml(ogMatch[1])
        .replace(/\s*[|–—-]\s*The Movie Database.*$/i, '')
        .trim();

      if (fallback) {
        log('Using TMDB page-title fallback: ' + fallback);
        return fallback;
      }
    }

    throw new Error('Could not resolve a title from TMDB');
  });
}

function getQueryTitle(tmdbId, mediaType, extraTitle) {
  // Optional third-party/test-harness title.
  if (typeof extraTitle === 'string' && extraTitle.trim()) {
    return Promise.resolve(extraTitle.trim());
  }

  if (tmdbId && typeof tmdbId === 'object') {
    var title = isTvType(mediaType)
      ? (tmdbId.original_name || tmdbId.name ||
         tmdbId.original_title || tmdbId.title)
      : (tmdbId.original_title || tmdbId.title ||
         tmdbId.original_name || tmdbId.name);

    if (title) {
      return Promise.resolve(String(title).trim());
    }

    tmdbId = tmdbId.tmdbId || tmdbId.tmdb_id || tmdbId.id;
  }

  if (tmdbId === undefined || tmdbId === null ||
      String(tmdbId).trim() === '') {
    return Promise.reject(new Error('No TMDB ID supplied'));
  }

  // A non-numeric value is treated as an already-resolved title.
  if (!/^\d+$/.test(String(tmdbId).trim())) {
    return Promise.resolve(String(tmdbId).trim());
  }

  return titleFromTmdbPage(tmdbId, mediaType);
}

/* -------------------- CircleFTP API -------------------- */

function searchPosts(queryTitle) {
  var url = API_URL +
    '?searchTerm=' + encodeURIComponent(queryTitle) +
    '&order=desc';

  log('Searching CircleFTP: ' + queryTitle);

  return fetch(url, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Referer': BASE_URL + '/'
    }
  }).then(function (response) {
    if (!response.ok) {
      throw new Error('Search API HTTP ' + response.status);
    }

    return response.json();
  }).then(function (data) {
    var posts = data && Array.isArray(data.posts)
      ? data.posts
      : [];

    log('API returned ' + posts.length + ' posts');

    // Do not sort, score, or reorder the API response.
    posts.forEach(function (post, index) {
      log('API[' + index + ']: id=' + post.id +
        ', type=' + post.type +
        ', title=' + (post.title || post.name || 'Untitled'));
    });

    return posts;
  });
}

function getPostDetails(postId) {
  return fetch(
    API_URL + '/' + encodeURIComponent(String(postId)),
    {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Referer': BASE_URL + '/'
      }
    }
  ).then(function (response) {
    if (!response.ok) {
      throw new Error(
        'Post details HTTP ' + response.status +
        ' for post ' + postId
      );
    }

    return response.json();
  });
}

/* -------------------- Movie streams -------------------- */

function makeMovieStream(details, queryTitle) {
  var url = typeof details.content === 'string'
    ? details.content.trim()
    : '';

  if (!/^https?:\/\//i.test(url)) {
    log('Movie post ' + details.id + ' has no direct media URL');
    return [];
  }

  return [{
    name: PROVIDER_NAME,
    title: details.title || details.name || queryTitle,
    url: url,
    quality: details.quality || 'Unknown',
    headers: {
      'Referer': BASE_URL + '/'
    }
  }];
}

function getMovieStreams(posts, queryTitle) {
  // Keep all non-series results in the API's original order.
  var moviePosts = posts.filter(function (post) {
    return String(post.type || '').toLowerCase() !== 'series';
  });

  log('Movie posts to resolve: ' + moviePosts.length);

  // Promise.all preserves the input order even if requests
  // complete in a different order.
  return Promise.all(moviePosts.map(function (post) {
    return getPostDetails(post.id).then(function (details) {
      return makeMovieStream(details, queryTitle);
    }).catch(function (error) {
      log('Movie post ' + post.id + ' failed: ' +
        (error && error.message ? error.message : String(error)));

      // One failed post must not discard the other results.
      return [];
    });
  })).then(function (results) {
    var streams = [];

    results.forEach(function (result) {
      result.forEach(function (stream) {
        streams.push(stream);
      });
    });

    log('Final movie streams: ' + streams.length);

    streams.forEach(function (stream, index) {
      log('STREAM[' + index + ']: ' + stream.title);
    });

    return streams;
  });
}

/* -------------------- TV season/episode helpers -------------------- */

function findSeason(content, seasonNumber) {
  if (!Array.isArray(content)) return null;

  var requested = parseInt(seasonNumber, 10);

  if (isNaN(requested) || requested < 1) {
    requested = 1;
  }

  for (var i = 0; i < content.length; i++) {
    var season = content[i];
    var seasonName = String(season.seasonName || '');
    var match = seasonName.match(/season\s*(\d+)/i);

    if (match && parseInt(match[1], 10) === requested) {
      return season;
    }
  }

  // If only one unnamed season exists, use it.
  if (content.length === 1 && !content[0].seasonName) {
    return content[0];
  }

  return null;
}

function findEpisode(season, episodeNumber) {
  if (!season || !Array.isArray(season.episodes)) {
    return null;
  }

  var requested = parseInt(episodeNumber, 10);

  if (isNaN(requested) || requested < 1) {
    requested = 1;
  }

  // Prefer episode numbers embedded in titles, such as S1E3.
  for (var i = 0; i < season.episodes.length; i++) {
    var item = season.episodes[i];
    var title = String(item.title || '');

    var match = title.match(/\bS\d+\s*E(\d+)\b/i) ||
      title.match(/\bE(?:pisode)?\s*(\d+)\b/i);

    if (match && parseInt(match[1], 10) === requested) {
      return item;
    }
  }

  // Fallback: use its position in the season.
  return season.episodes[requested - 1] || null;
}

function makeTvStream(
  details,
  queryTitle,
  seasonNumber,
  episodeNumber
) {
  if (!Array.isArray(details.content)) {
    log('TV post content is not a season array');
    return [];
  }

  var season = findSeason(details.content, seasonNumber);

  if (!season) {
    log('Season ' + seasonNumber + ' was not found');
    return [];
  }

  var episode = findEpisode(season, episodeNumber);

  if (!episode) {
    log('Episode ' + episodeNumber + ' was not found');
    return [];
  }

  var url = String(episode.link || '').trim();

  if (!/^https?:\/\//i.test(url)) {
    log('Selected episode has no valid URL');
    return [];
  }

  log('Selected ' + (season.seasonName || 'Season ' + seasonNumber) +
    ', episode ' + episodeNumber + ': ' + episode.title);

  return [{
    name: PROVIDER_NAME,
    title: episode.title ||
      (details.name || queryTitle) +
      ' S' + seasonNumber + 'E' + episodeNumber,
    url: url,
    quality: details.quality || 'Unknown',
    headers: {
      'Referer': BASE_URL + '/'
    }
  }];
}

/* -------------------- Nuvio entry point -------------------- */

function getStreams(tmdbId, mediaType, season, episode) {
  var tv = isTvType(mediaType);

  log('getStreams called: id=' + tmdbId +
    ', type=' + mediaType +
    ', season=' + season +
    ', episode=' + episode);

  return getQueryTitle(tmdbId, mediaType).then(function (queryTitle) {
    queryTitle = String(queryTitle || '').trim();

    if (!queryTitle) {
      throw new Error('Resolved title is empty');
    }

    log('Search title: ' + queryTitle);

    return searchPosts(queryTitle).then(function (posts) {
      if (!posts.length) {
        log('No CircleFTP results for: ' + queryTitle);
        return [];
      }

      if (!tv) {
        return getMovieStreams(posts, queryTitle);
      }

      // Select the first series in the API response.
      // No scoring or sorting is applied.
      var seriesPost = null;

      for (var i = 0; i < posts.length; i++) {
        if (String(posts[i].type || '').toLowerCase() === 'series') {
          seriesPost = posts[i];
          break;
        }
      }

      if (!seriesPost) {
        log('No series post found in API response');
        return [];
      }

      log('Selected series post: ' +
        seriesPost.id + ' - ' + seriesPost.title);

      return getPostDetails(seriesPost.id).then(function (details) {
        return makeTvStream(
          details,
          queryTitle,
          season,
          episode
        );
      });
    });
  }).catch(function (error) {
    log('ERROR: ' + (
      error && error.stack
        ? error.stack
        : error && error.message
          ? error.message
          : String(error)
    ));

    return [];
  });
}

module.exports = {
  getStreams: getStreams
};
