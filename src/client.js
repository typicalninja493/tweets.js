const constants = require("./utils/constants");
const Func = require("./utils/functions.js");
const querystring = require("querystring");
const streamManager = require("./streamManager");
const wait = require("util").promisify(setTimeout);
// request client
const fetch = require("node-fetch");

// Internal Structures
const tweet = require("./struc/tweet.js");
const User = require("./struc/user");


/**
 * The core client
 * @class
 * @param {ClientOptions} Options - Options for tweets.js client
 */
class client {
  constructor(options = {}) {
    if (!options || typeof options !== "object")
      throw new Error("Options not provided");
    // the raw options provided by the user
    this._RawOptions = options;
    // the merged options
    const config = Object.assign({}, constants.DefaultOptions, options);
    this._options = Object.freeze(config);
    this.streamData = {};
    if (this._options.emitter) this.streamData.indefinite = true;
    if (this._options.emitterUrl)
      this.streamData.streamUrl = this._options.emitterUrl;
    if (this._options.autoReconnect)
      this.streamData.reconnect = this._options.autoReconnect;
    // set the version for future use
    this.version = config.version == "1.1" ? "1" : "2";
    // Set the auth type for restricting function to certain types
    /**
     * The type this client has authenticated as
     * @type {String}
     * @private
     */
    this.authenticationType = config.bearer_token ? "APP" : "USER";
    // create the main internal oauth client
    this._client = Func.createClient(
      config.consumer_key,
      config.consumer_secret
    );
    // get the base url
    this.BaseUrl = Func.getUrl(config.subdomain, config.version);
    this.uploadUrl = Func.getUrl("upload", config.version);

    if (this.authenticationType === "USER") {
      /**
       * User data
       * @type {String}
       * @private
       */
      this._UserData = {
        key: this._options.access_token,
        secret: this._options.access_token_secret,
      };
    }

    if (this._options.verifyCredentials) {
      this.verifyCredentials()
        .then((r) => {
          this.user = new User(r, this);
        })
        .catch(() => {
          throw new Error("Credentials invalid");
        });
    }

    this.stream = null;

    this.pingTimeout = null;
  }
  /**
   * Build all the data required to be sent to twitter
   * @param {string} method - 'GET' or 'POST'
   * @param {string} path - the API endpoint
   * @param {object} parameters - request parameters
   * @private
   */
  _buildRequest(method, path, parameters) {
    const Data = {
      url: `${
        constants.upload_ends.includes(path) ? this.uploadUrl : this.BaseUrl
      }/${path}${this.version == "1" ? ".json" : ""}`,
      method: method,
    };

    if (parameters) {
      if (method === "POST") Data.data = parameters;
      else Data.url += "?" + querystring.stringify(parameters);
    }

    let headers = {};
    if (this.authenticationType === "USER") {
      headers = this._client.toHeader(
        this._client.authorize(Data, this._UserData)
      );
    } else {
      headers = {
        Authorization: `Bearer ${this._options.bearer_token}`,
      };
    }
    return {
      Data,
      headers,
    };
  }
  /**
   * Handle the returned response from the fetch request
   * @param {Response} response -   Returned response
   * @private
   */
  async _handleResponse(resp) {
    const headers = resp.headers;

    if (resp.ok) {
      // Return empty response on 204 , or content-length = 0
      if (resp.status === 204 || resp.headers.get("content-length") === "0")
        return {
          _headers: headers,
        };
      // Otherwise, parse JSON response
      return resp.json().then((res) => {
        res._headers = headers;
        return res;
      });
    } else {
      throw {
        _headers: headers,
        ...(await resp.json()),
      };
    }
  }
  /**
   * Send a GET request
   * @param {string} path - endpoint, e.g. `followers/ids`
   * @param {object} [parameters] - optional parameters
   */
  get(path, parameters) {
    const reqData = this._buildRequest("GET", path, parameters);
    const headers = Object.assign(
      {},
      constants.BASE_GET_HEADERS,
      reqData.headers
    );
    return fetch(reqData.Data.url, { headers: headers }).then(
      this._handleResponse
    );
  }
  // https://github.com/draftbit/twitter-lite/blob/master/twitter.js#L40
  /**
   * Send a post request
   * @param {string} path - endpoint, e.g. `followers/ids`
   * @param {object} [parameters] - optional parameters
   */
  post(path, parameters) {
    const reqData = this._buildRequest(
      "POST",
      path,
      constants.JSON_ENDPOINTS.includes(path) ? null : parameters // don't sign JSON bodies; only parameters
    );

    const Headers = Object.assign({}, constants.BASE_HEADERS, reqData.headers);

    if (constants.JSON_ENDPOINTS.includes(path)) {
      parameters = JSON.stringify(parameters);
    } else {
      parameters = Func.percentEncode(querystring.stringify(parameters));
      Headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    return fetch(reqData.Data.url, {
      method: "POST",
      headers: Headers,
      body: parameters,
    }).then(this._handleResponse);
  }

  /**
   * post a tweet
   * @param {string} message - tweet to post
   * @param {object} options - tweet options
   * @param {object} options.body - additional body with the constructed body
   * @returns {tweet}
   */
  async tweet(message, options = {}) {
    if (this.authenticationType !== "USER")
      throw new Error(
        `Auth type must be a user type to tweet, got "${this.authenticationType}"`
      );
    if (!message) throw new Error("Cannot tweet a empty message");
    if (options && typeof options !== "object")
      throw new Error("Options must be a object");
    const body = {
      status: message,
    };
    // add user provided body to original body
    if (options.body && typeof options.body == "object") {
      const keys = Object.keys(options.body);
      keys.forEach((key) => {
        body[key] = options.body[key];
      });
    }
    const request = await this.post("statuses/update", body);
    return new tweet(request, this);
  }

  /**
   * gets a tweet
   * @param {Array} tweetIds - Array of tweet ids to get
   * @param {object} options - method options
   * @param {object} options.include_entities - The entities node that may appear within embedded statuses will not be included when set to false.
   * @return {Array<tweet>}
   */
  async getTweets(tweetIds = [], options = {}) {
    if (!Array.isArray(tweetIds)) throw new Error("tweet ids must be a array");
    const joinedArray = tweetIds.join(",");

    const parameters = {
      id: joinedArray,
    };

    if (options.include_entities)
      parameters.include_entities = options.include_entities;

    const request = await this.get("statuses/lookup", parameters);

    if (request.length <= 0)
      throw new Error("Did not find any tweets with the specified tweetIds");
    const tweets = [];
    for (const tweet_X of request) {
      if (tweet_X.id) {
        const constructed = new tweet(tweet_X, this);
        tweets.push(constructed);
      }
    }
    return tweets;
  }

  /**
   * reply to a tweet
   * @param {string} message - tweet to post
   * @param {string} to - Id of the tweet to reply
   * @param {object} options - options for reply()
   * @param {object} options.body - additional body with the constructed body
   * @returns {tweet}
   */
  async reply(message, to, options = {}) {
    if (this.authenticationType !== "USER")
      throw new Error(
        `Auth type must be a user type to tweet/reply, got "${this.authenticationType}"`
      );
    if (!to) throw new Error(`Need a tweet id to reply to`);
    if (!message) throw new Error("Cannot reply with a empty message");
    if (options && typeof options !== "object")
      throw new Error("Options must be a object");

    const body = {
      status: message,
      in_reply_to_status_id: to,
      auto_populate_reply_metadata: true,
    };

    if (options.body && typeof options.body == "object") {
      const keys = Object.keys(options.body);
      keys.forEach((key) => {
        body[key] = options.body[key];
      });
    }

    const request = await this.post("statuses/update", body);
    return new tweet(request, this);
  }

  /**
   * Make a thread
   * @param {Array<any>} threadMessages - Array of messages to make a thread out of
   * @param {Object} options - options for either reply() or tweet()
   * @param {String} options.lastTweetID - starting the thread with already posted tweet?
   * @param {String} options.delay - add a delay to in how many time it should take to post it tweet, default to 10000
   * @return {Promise<tweet[]>}
   */
  async thread(threadMessages = [], options = {}) {
    if (this.authenticationType !== "USER")
      throw new Error(
        `Auth type must be a User, got "${this.authenticationType}"`
      );
    if (!threadMessages) throw new Error("Cannot create a empty thread");
    if (!Array.isArray(threadMessages))
      throw new Error(
        `threadMessages Must be a array got "${typeof threadMessages}"`
      );
    if (options.functionOptions && typeof options.functionOptions !== "object")
      throw new Error(
        `functionOptions must be a object. got ${typeof options.functionOptions}`
      );

    // keep track of the last tweet posted
    let lastTweetID = options.lastTweetID || null;
    // make a empty array to be returned later with all the thread tweets classes
    const threads = [];
    for (const message of threadMessages) {
      // Add a delay to stop getting rate limited
      if (
        options.delay &&
        isNaN(parseInt(options.delay)) &&
        parseInt(options.delay) > 3000
      )
        await wait(parseInt(options.delay));
      else await wait(10000);
      // if this is the first message
      if (!lastTweetID) {
        const tweet = await this.tweet(message, options.functionOptions);
        if (tweet.id) {
          lastTweetID = tweet.id;
        }
        threads.push(tweet);
        // if this is one of the messages after the first
      } else {
        const tweet = await this.reply(message, lastTweetID, options);
        if (tweet.id) {
          lastTweetID = tweet.id;
        }
        threads.push(tweet);
      }
    }
    // return the threads
    return threads;
  }

  /**
   * Follow a user
   * @param {String} user - A user id or screen name
   * @param {Boolean} notifications - weather to Enable notifications for the target user
   * @returns {Promise<User>}
   */
  async follow(user, notifications = true) {
    if (this.authenticationType !== "USER")
      throw new Error(
        `Auth type must be a User, got "${this.authenticationType}"`
      );
    if (!user)
      throw new Error(
        "Please give me either a user id or a user screen name to follow"
      );
    if (typeof user !== "string" && typeof user !== "number" && isNaN(user))
      throw new Error(
        `User must be a userID (number) or a user scree name, received ${typeof user}`
      );
    // empty object, add values to this
    const body = {};
    // decide if a user id or a screen Name was provided
    if (isNaN(parseInt(user))) body.screen_name = user;
    else body.user_id = user;
    // if notifs are enabled or not
    if (notifications) body.follow = true;
    else body.follow = false;
    // send the request
    const request = await this.post("friendships/create", body);
    return new User(request, this);
  }

  /**
   * unFollows a user
   * @param {String} user - A user id or screen name
   * @returns {Promise<User>}
   */
  async unfollow(user) {
    if (this.authenticationType !== "USER")
      throw new Error(
        `Auth type must be a User, got "${this.authenticationType}"`
      );
    if (typeof user !== "string" && typeof user !== "number" && isNaN(user))
      throw new Error(
        `User must be a userID (number) or a user scree name, received ${typeof user}`
      );

    // empty object, add values to this
    const body = {};
    // decide if a user id or a screen Name was provided
    if (isNaN(parseInt(user))) body.screen_name = user;
    else body.user_id = user;

    const request = await this.post("friendships/destroy", body);
    return new User(request, this);
  }

  /**
   * unFollows a user
   * @param {String} file - A url or a file path to image/media file
   * @param {Object} options - options for uploadMedia()
   * @param {String} options.altText - alt text for image
   * @param {String} options.message - optional message to post with the media
   * @returns {Promise<tweet>}
   */
  async uploadMedia(file, options = {}) {
    if (!Func.isUrl(file) && !Func.isPath(file))
      throw new Error(`${file}, is not a valid path or a URl to a file`);
    const preparedFile = await Func.prepareFile(file);

    const body = {
      media_data: preparedFile,
    };

    const request = await this.post("media/upload", body);
    const altText = options.altText ? options.altText : "tweets.js-img";
    const mediaIdStr = request.media_id_string;

    const meta_data_body = {
      media_id: mediaIdStr,
      alt_text: { text: altText },
    };

    await this.post("media/metadata/create", meta_data_body);
    const params = {
      media_ids: [mediaIdStr],
    };

    if (options.message) params.status = options.message;

    const req = await this.post("statuses/update", params);

    return new tweet(req, this);
  }

  async verifyCredentials() {
    const req = await this.get("account/verify_credentials");

    return new User(req);
  }

  /**
   * Search users by a query
   * @param {String} query - query to search users of, ex: nodejs
   * @param {Object} options - request options
   * @param {String} options.page - Specifies the page of results to retrieve.
   * @param {String} options.count - The number of potential user results to retrieve per page. This value has a maximum of 20.
   * @param {string} options.includeEntities - The entities node will not be included in embedded Tweet objects when set to false
   * @returns {Promise<User[]>}
   */
  async searchUsers(query, options = {}) {
    if (this.authenticationType !== "USER")
      throw new Error(
        `Auth type must be a User, got "${this.authenticationType}"`
      );
    if (!query) throw new Error("Cannot search for a empty query");
    if (typeof query !== "string") throw new Error("query must be a string,");
    if (typeof options !== "object")
      throw new Error("options must be a object");
    const parameters = {
      q: query,
      page: "1",
      count: "2",
    };
    if (
      options.page &&
      !isNaN(parseInt(options.page)) &&
      parseInt(options.page) <= 10
    )
      parameters.page = options.page;
    if (
      options.count &&
      !isNaN(parseInt(options.count)) &&
      parseInt(options.count) <= 20
    )
      parameters.count = options.count;
    if (options.includeEntities && typeof options.includeEntities === "boolean")
      parameters.include_entities = options.includeEntities;
    // do request
    const request = await this.get("users/search", parameters);
    // keep a array to push later
    const users = [];

    for (const user of request) {
      const constructedUserClass = new User(user, this);
      users.push(constructedUserClass);
    }

    return users;
  }

  /**
   * Get a users follower list
   * @param {String} user - A user id or screen name
   * @param {Object} options - Options for twitter api
   * @param {String} options.count - The number of user results to retrieve, max of 200
   * @param {Boolean} options.skip_status - Weather to not include status in the api response
   * @param {Boolean} options.include_user_entities - The user object entities node will not be included when set to false
   * @returns {Promise<User[]>}
   */
  async getFollowers(user, options = {}) {
    if (typeof user !== "string" && typeof user !== "number" && isNaN(user))
      throw new Error(
        `User must be a userID (number) or a user scree name (String), received ${typeof user}`
      );
    if (options && typeof options !== "object")
      throw new Error(`Options must be a object, ${typeof options}`);

    const parameters = {};

    if (isNaN(parseInt(user))) parameters.screen_name = user;
    else parameters.user_id = user;

    if (
      options.count &&
      !isNaN(parseInt(options.count)) &&
      parseInt(options.count) <= 200
    )
      parameters.count = options.count;
    if (options.skip_status && options.skip_status == true)
      parameters.count = true;
    if (
      options.include_user_entities &&
      parameters.include_user_entities == false
    )
      parameters.include_user_entities = false;

    const request = await this.get("followers/list", parameters);
    const users = [];
    if (request.users && Array.isArray(request.users)) {
      for (user of request.users) {
        const constructedUserClass = new User(user, this);
        users.push(constructedUserClass);
      }
    }
    return users;
  }

  /**
   * gets A specific user from the api
   * @param {String} user - A user id or screen name
   * @returns {Promise<User>}
   */
  async getUser(user) {
    if (typeof user !== "string" && typeof user !== "number" && isNaN(user))
      throw new Error(
        `User must be a userID (number) or a user scree name (String), received ${typeof user}`
      );

    // empty object, add values to this
    const parameters = {};
    // decide if a user id or a screen Name was provided
    if (isNaN(parseInt(user))) parameters.screen_name = user;
    else parameters.user_id = user;

    const request = await this.get("users/show", parameters);

    return new User(request, this);
  }

  /**
   * retweet a tweet
   * @param {String} tweetID - the id of the tweet
   * @returns {Promise<tweet>} returns the tweet object for this tweet
   */
  async retweet(tweetID) {
    if (this.authenticationType !== "USER")
      throw new Error(
        `Auth type must be a User, got "${this.authenticationType}"`
      );
    if (!tweetID) throw new Error("Tweet id must be present");
    if (typeof tweetID !== "string")
      throw new Error(`tweetID must be a string, received ${typeof tweetID}`);

    const urlToPost = `statuses/retweet/${tweetID}`;

    const request = await this.post(urlToPost);
    return new tweet(request, this);
  }
  /**
   * Start the stream
   * @param {Object} parameters - parameters for twitter api
   * @param {String} path - url to stream, defaults to what you set as stream url in client options
   * @returns {streamManager}
   */
  start(parameters = {}, path = this.streamData.streamUrl) {
    if (this.authenticationType !== "USER")
      throw new Error(
        `Auth type must be a User, got "${this.authenticationType}"`
      );
    if (!this.streamData.indefinite) throw new Error("Stream disabled");
    if (!parameters) throw new Error("Parameter must be present");
    if (this.stream) throw new Error("Stream already active");
    this.stream = new streamManager(this._client, {
      userData: this._UserData,
      path: path,
      version: this.version,
      reconnect: this._options.autoReconnect,
      reconnectInterval: this._options.autoReconnect,
    });
    this.stream._connect(parameters);
    return this.stream;
  }
}

module.exports = client;
