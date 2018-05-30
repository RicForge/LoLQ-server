//
//
//   ___       ________  ___       ________
//  |\  \     |\   __  \|\  \     |\   __  \
//  \ \  \    \ \  \|\  \ \  \    \ \  \|\  \
//   \ \  \    \ \  \\\  \ \  \    \ \  \\\  \
//    \ \  \____\ \  \\\  \ \  \____\ \  \\\  \
//     \ \_______\ \_______\ \_______\ \_____  \
//      \|_______|\|_______|\|_______|\|___| \__\ 
//                                          \|__|
//       API proxy and data server
//
//   Copyright (C) 2018  Ric <ric@lolq.org>
//
//   https://www.lolq.org
//
//   This program is free software: you can redistribute it and/or modify
//   it under the terms of the GNU General Public License as published by
//   the Free Software Foundation, either version 3 of the License, or
//   (at your option) any later version.
//
//   This program is distributed in the hope that it will be useful,
//   but WITHOUT ANY WARRANTY; without even the implied warranty of
//   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//   GNU General Public License for more details.
//
//   You should have received a copy of the GNU General Public License
//   along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
//

const os					= require('os')
const path	 				= require('path')
const fs					= require('fs')
const async					= require('async')

const express				= require('express')
const app					= express()
const helmet				= require('helmet')
const mysql					= require('mysql')
const redis					= require('redis')
const {Kayn}				= require('kayn')

const serverVersion			= require('./package.json').version
const expressVersion		= require('express/package.json').version
const helmetVersion			= require('helmet/package.json').version
const mysqlVersion			= require('mysql/package.json').version
const redisVersion			= require('redis/package.json').version
const kaynVersion			= require('kayn/package.json').version



/********************************************************************
*********************************************************************

██████╗ ██████╗ ███╗   ██╗███████╗██╗ ██████╗ 
██╔════╝██╔═══██╗████╗  ██║██╔════╝██║██╔════╝ 
██║     ██║   ██║██╔██╗ ██║█████╗  ██║██║  ███╗
██║     ██║   ██║██║╚██╗██║██╔══╝  ██║██║   ██║
╚██████╗╚██████╔╝██║ ╚████║██║     ██║╚██████╔╝
 ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝     ╚═╝ ╚═════╝ 

*********************************************************************
********************************************************************/

const g_serverDir			= __dirname
const g_homeDir				= os.homedir()

const g_serverConfig		= path.join(g_homeDir, '.lolq-server-config.json')

// Expiration times for memory-cached data (seconds)
const MEMCACHE_SUMMONER_EXPIRE		= 60 * 10
const MEMCACHE_LEAGUES_EXPIRE		= 60 * 10
const MEMCACHE_MATCHLIST_EXPIRE		= 60 * 10


//*******************************************************************
//*******************************************************************
//*******************************************************************
//*******************************************************************


const SERVER_LISTEN_HOST		= require(g_serverConfig).SERVER_LISTEN_HOST
const SERVER_LISTEN_PORT		= require(g_serverConfig).SERVER_LISTEN_PORT
const SERVER_LISTEN_PORT_DEV	= require(g_serverConfig).SERVER_LISTEN_PORT_DEV
const RIOT_API_KEY				= require(g_serverConfig).RIOT_API_KEY
let MYSQL_USERS_TABLE			= require(g_serverConfig).MYSQL_USERS_TABLE
let MYSQL_MATCHDATA_CACHE_TABLE = require(g_serverConfig).MYSQL_MATCHDATA_CACHE_TABLE
const REDIS_HOST				= require(g_serverConfig).REDIS_HOST
const REDIS_PORT				= require(g_serverConfig).REDIS_PORT
const CHAMPIONDATA_DIR			= require(g_serverConfig).CHAMPIONDATA_DIR


const REGION_IDS = {
	'br'	: 1,
	'eune'	: 2,
	'euw'	: 3,
	'jp'	: 4,
	'kr'	: 5,
	'lan'	: 6,
	'las'	: 7,
	'na'	: 8,
	'oce'	: 9,
	'tr'	: 10,
	'ru'	: 11,
}


const MEMCACHE_KEYS = {
	"summoner"	: 1,
	"leagues"	: 2,
	"matchlist"	: 3
}


const ERRNO_SQL_QUERY_FAILED	= '10666'
const ERRNO_ACCES_DENIED		= '10403'
const ERRNO_ACCESS_TOKEN_BANNED	= '10777'

let g_server				= null
let g_serverQuitting		= false

let g_sql					= null
let g_sqlConnected			= false

let g_redisClient			= null
let g_memCacheEnabled		= false

let g_kayn					= null

let g_championData			= []



/********************************************************************
*********************************************************************

██╗    ███╗   ██╗    ██╗    ████████╗
██║    ████╗  ██║    ██║    ╚══██╔══╝
██║    ██╔██╗ ██║    ██║       ██║   
██║    ██║╚██╗██║    ██║       ██║   
██║    ██║ ╚████║    ██║       ██║   
╚═╝    ╚═╝  ╚═══╝    ╚═╝       ╚═╝   

*********************************************************************
********************************************************************/

function initServer() {
	process.on('SIGINT', shutdownServer)

	_initLogging()

	_initKayn()

	_initRedis()

	_initMySQL()

	app.use(helmet())

	if(process.env.LOLQ_DEV) {
		app.set('json spaces', 4);
	}

	var regionReg = ':region(br|eune|euw|jp|kr|lan|las|na|oce|tr|ru)'
	var keyReg = ':key(LOLQ-\\w{8}-\\w{4}-\\w{4}-\\w{4}-\\w{12})'

	// Add handlers
	app.get('/getSummonerByName/' + regionReg + '/:name/' + keyReg, _getSummonerByName)
	app.get('/getLeaguesBySummonerId/' + regionReg + '/:summonerId(\\d+)/' + keyReg, _getLeaguesBySummonerId)
	app.get('/getMatchlistByAccountId/' + regionReg + '/:accountId(\\d+)/' + keyReg, _getMatchlistByAccountId)
	app.get('/getMatchByGameId/' + regionReg + '/:gameId(\\d+)/' + keyReg, _getMatchByGameId)

	app.get('/checkAccessToken/' + keyReg, _checkAccessTokenURLHandler)

	app.get('/championData/:elo(BRONZE|SILVER|GOLD|PLATINUMPLUS)/' + keyReg, _championDataHandler)

	app.get('*', (req, res) => {
		res.json("Access denied")
	})
}

initServer()

// On first startup: wait till we have a db connection before starting server
let firstStart = setInterval(() => {
	if(g_sqlConnected && !g_serverQuitting) {
		_lolqLog()
		_readChampionData((err) => {
			if(err) {
				_lolqLog()
				clearInterval(firstStart)
				shutdownServer()
				return
			}

			let listenPort = SERVER_LISTEN_PORT
			if(process.env.LOLQ_DEV) {
				listenPort = SERVER_LISTEN_PORT_DEV
			}
			g_server = app.listen(listenPort, SERVER_LISTEN_HOST, () => {
				_lolqLog()
				_lolqLog('[white-blue][Express] Server listening on ' + SERVER_LISTEN_HOST + ':' + listenPort + '[reset]')
				_lolqLog()
			})
			clearInterval(firstStart)
		})
	}
}, 1000)


// Maintenance tasks every 15mins
function _maintenanceTasks() {
	_readChampionData((err) => {
		if(err) {
			// Don't close the server on error, since we have old championData to keep us running
			// TODO: Notify server admin
		}
	})
	setTimeout(_maintenanceTasks, 900000)
}
setTimeout(_maintenanceTasks, 900000)


function _initMySQL() {
	let json = JSON.parse(fs.readFileSync(g_serverConfig, 'utf8'))

	const g_mysqlOpts = {
		host		: json.MYSQL_HOST,
		port		: json.MYSQL_PORT,
		user		: json.MYSQL_USER,
		password	: json.MYSQL_PASSWORD,
		database	: json.MYSQL_DB
	}

	MYSQL_USERS_TABLE = json.MYSQL_USERS_TABLE
	MYSQL_MATCHDATA_CACHE_TABLE = json.MYSQL_MATCHDATA_CACHE_TABLE

	g_sql = mysql.createConnection(g_mysqlOpts)
	
	g_sql.connect(function(err) {
		if(err) {
			_lolqLog('[cyan]MySQL:[reset] [red]Unable to connect to ' + g_mysqlOpts.host + ':' + g_mysqlOpts.port + ' (' + err.code + '), retrying in 10 seconds...[reset]');
			setTimeout(_initMySQL, 10000);
		} else {
			_lolqLog('[cyan]MySQL: Connected to ' + g_mysqlOpts.host + ':' + g_mysqlOpts.port + ' db: ' + g_mysqlOpts.database + '[reset]');
			g_sqlConnected = true
			g_sql.query('SHOW VARIABLES WHERE Variable_name LIKE "version" OR Variable_name LIKE "version_comment"', function (error, results, fields) {
				if(error) {
					_lolqLog('[cyan]MySQL:[reset] [red]Warning: Could not query server version: ' + error + '[reset]');
				} else {
					_lolqLog('[cyan]MySQL: ' + results[1].Value + ' version ' + results[0].Value + '[reset]');
				}
			})
		}
	   
	})

	g_sql.on('error', function(err) {
		g_sqlConnected = false
		if(err.code === 'PROTOCOL_CONNECTION_LOST') {
			_lolqLog('[cyan]MySQL:[reset] [red]connection lost, attempting to reconnect[reset]');
		} else {
			_lolqLog('[cyan]MySQL:[reset] [red]Unhandled MySQL error: ' + err.code + '[reset]');
		}
		_initMySQL()
	})
}


function _initRedis() {
	g_redisClient = redis.createClient({
		// Reconnect after 10s
		retry_strategy: function (options) {
			_lolqLog('[yellow]Redis:[reset] [red]Unable to connect to ' + REDIS_HOST + ':' + REDIS_PORT + ', retrying in 10 seconds...[reset]')
			return 10000
		}
	})

	g_redisClient.on('connect', () => {
		_lolqLog('[yellow]Redis: connected to redis server at ' + REDIS_HOST + ':' + REDIS_PORT + '[reset]')
	})

	g_redisClient.on('ready', () => {
		_lolqLog('[yellow]Redis: server version: ' + g_redisClient.server_info.redis_version + '[reset]')
		if(!g_memCacheEnabled) {
			_lolqLog('[yellow]Redis: Enabling memcache for API calls[reset]')
			g_memCacheEnabled = true
		}
	})

	g_redisClient.on('end', () => {
		if(!g_serverQuitting) {
			_lolqLog('[yellow]Redis: connection lost, attempting to reconnect[reset]')
			if(g_memCacheEnabled) {
				_lolqLog('[yellow]Redis:[reset] [red]DISABLING API CALLS MEMCACHE[reset]')
				g_memCacheEnabled = false
			}
		}
	})

	g_redisClient.on('error', (err) => {
		_lolqLog('[yellow]Redis:[reset] [red]' + err + '[reset]')
	})
}


function _initKayn() {
	g_kayn = Kayn(RIOT_API_KEY)({
		requestOptions: {
			burst: false
		}
	})

	/*{
		region: REGIONS.NORTH_AMERICA,
		debugOptions: {
			isEnabled: true,
			showKey: false,
		},
		requestOptions: {
			shouldRetry: true,
			numberOfRetriesBeforeAbort: 3,
			delayBeforeRetry: 1000,
			burst: false,
		},
		cacheOptions: {
			cache: null,
			timeToLives: {
				useDefault: false,
				byGroup: {},
				byMethod: {},
			},
		},
	}*/

	_lolqLog('_initKayn(): npm-kayn initialized')
}


function shutdownServer() {
	g_serverQuitting = true

	if(g_server) {
		g_server.close(() => {
			g_server = null
			_lolqLog('[white-blue][Express] Server closed[reset]')
		})
	}

	if(g_redisClient) {
		g_memCacheEnabled = false
		g_redisClient.quit()
		g_redisClient = null
		_lolqLog('[yellow]Redis: connection closed[reset]')
	}
	
	if(g_sql) {
		g_sqlConnected = false
		g_sql.end(() => {
			g_sql = null
			_lolqLog('[cyan]MySQL: connection closed[reset]');
		})
	}

	// Quit after 3 seconds
	setTimeout(() => {
		_endLogging()
		process.exit(0)
	}, 3000)
}



/********************************************************************
*********************************************************************

██╗  ██╗ █████╗ ███╗   ██╗██████╗ ██╗     ███████╗██████╗ ███████╗
██║  ██║██╔══██╗████╗  ██║██╔══██╗██║     ██╔════╝██╔══██╗██╔════╝
███████║███████║██╔██╗ ██║██║  ██║██║     █████╗  ██████╔╝███████╗
██╔══██║██╔══██║██║╚██╗██║██║  ██║██║     ██╔══╝  ██╔══██╗╚════██║
██║  ██║██║  ██║██║ ╚████║██████╔╝███████╗███████╗██║  ██║███████║
╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝╚══════╝

*********************************************************************
********************************************************************/

function _getSummonerByName(req, res) {
	let region = req.params.region
	let accessToken = req.params.key.substr(5)

	let summonerName = req.params.name

	let ip = req.connection.remoteAddress;

	_checkAccessToken(accessToken, (err, id) => {
		if(err) {
			if(err == ERRNO_ACCES_DENIED) {
				_lolqLog('[green]_getSummonerByName():[reset] [red]DENIED REQUEST for ' + region + '/' + summonerName + ' from: ' + ip + '[reset]', 1)
			} else if(err == ERRNO_ACCESS_TOKEN_BANNED) {
				_lolqLog('[green]_getSummonerByName():[reset] [red]BANNED REQUEST for ' + region + '/' + gameId + ' from: ' + ip + '[reset]', 1)
			}
			res.json({"statusCode": err})
			return
		}

		let cacheKey = MEMCACHE_KEYS['summoner'] + '-' + REGION_IDS[region] + '-' + summonerName

		_getFromMemCache(cacheKey, (reply) => {
			if(reply) {
				// Found in memcache
				res.json(JSON.parse(reply))
				_incrementMemCacheHits(id)
				_lolqLog('[green]_getSummonerByName():[reset] [yellow](MEM CACHE HIT)[reset] [green]response for ' + region + '/' + summonerName + ' to ' + ip + '[reset]', 1)
			} else {
				// Not found in memcache, request from Riot API
				g_kayn.Summoner.by.name(summonerName).region(region).callback(function(err, summoner) {
					if(err) {
						res.json(err)
					} else {
						let summonerMinified = _minifySummonerData(summoner)
						res.json(summonerMinified)
						_lolqLog('[green]_getSummonerByName(): response for ' + region + '/' + summonerName + ' to ' + ip + '[reset]', 1)
						_addToMemCache(cacheKey, JSON.stringify(summonerMinified), MEMCACHE_SUMMONER_EXPIRE)
					}
		
					_incrementRiotApiRequests(id)
				})
			}
		})
	})
}


function _getLeaguesBySummonerId(req, res) {
	let region = req.params.region
	let accessToken = req.params.key.substr(5)

	let summonerId = req.params.summonerId

	let ip = req.connection.remoteAddress;

	_checkAccessToken(accessToken, (err, id) => {
		if(err) {
			if(err == ERRNO_ACCES_DENIED) {
				_lolqLog('[green]_getLeaguesById():[reset] [red]DENIED REQUEST for ' + region + '/' + summonerId + ' from: ' + ip + '[reset]', 1)
			} else if(err == ERRNO_ACCESS_TOKEN_BANNED) {
				_lolqLog('[green]_getLeaguesById():[reset] [red]BANNED REQUEST for ' + region + '/' + gameId + ' from: ' + ip + '[reset]', 1)
			}
			res.json({"statusCode": err})
			return
		}

		let cacheKey = MEMCACHE_KEYS['leagues'] + '-' + REGION_IDS[region] + '-' + summonerId

		_getFromMemCache(cacheKey, (reply) => {
			if(reply) {
				// Found in memcache
				res.json(JSON.parse(reply))
				_incrementMemCacheHits(id)
				if(process.env.LOLQ_DEV) {
					_lolqLog('[green]_getLeaguesBySummonerId():[reset] [yellow](MEM CACHE HIT)[reset] [green]response for ' + region + '/' + summonerId + ' to ' + ip + '[reset]', 1)
				}
			} else {
				// Not found in memcache, request from Riot API
				g_kayn.LeaguePositions.by.summonerID(summonerId).region(region).callback(function(err, leagues) {
					if(err) {
					res.json(err)
					} else {
						let leaguesMinified = _minifyLeaguesData(leagues)
						res.json(leaguesMinified)
						if(process.env.LOLQ_DEV) {
							_lolqLog('[green]_getLeaguesBySummonerId(): response for ' + region + '/' + summonerId + ' to ' + ip + '[reset]', 1)
						}
						_addToMemCache(cacheKey, JSON.stringify(leaguesMinified), MEMCACHE_LEAGUES_EXPIRE)
					}

					_incrementRiotApiRequests(id)
				})
			}
		})
	})
}


function _getMatchlistByAccountId(req, res) {
	let region = req.params.region
	let accessToken = req.params.key.substr(5)

	let accountId = req.params.accountId

	let ip = req.connection.remoteAddress;

	_checkAccessToken(accessToken, (err, id) => {
		if(err) {
			if(err == ERRNO_ACCES_DENIED) {
				_lolqLog('[green]_getMatchlistByAccountId():[reset] [red]DENIED REQUEST for ' + region + '/' + accountId + ' from: ' + ip + '[reset]', 1)
			} else if(err == ERRNO_ACCESS_TOKEN_BANNED) {
				_lolqLog('[green]_getMatchlistByAccountId():[reset] [red]BANNED REQUEST for ' + region + '/' + gameId + ' from: ' + ip + '[reset]', 1)
			}
			res.json({"statusCode": err})
			return
		}

		let cacheKey = MEMCACHE_KEYS['matchlist'] + '-' + REGION_IDS[region] + '-' + accountId

		_getFromMemCache(cacheKey, (reply) => {
			if(reply) {
				// Found in memcache
				res.json(JSON.parse(reply))
				_incrementMemCacheHits(id)
				if(process.env.LOLQ_DEV) {
					_lolqLog('[green]_getMatchlistByAccountId():[reset] [yellow](MEM CACHE HIT)[reset] [green]response for ' + region + '/' + accountId + ' to ' + ip + '[reset]', 1)
				}
			} else {
				// Not found in memcache, request from Riot API
				g_kayn.Matchlist.by.accountID(accountId).region(region).callback(function(err, matchlist) {
					if(err) {
						res.json(err)
					} else {
						let matchlistMinified = _minifyMatchlistData(matchlist)
						res.json(matchlistMinified)
						if(process.env.LOLQ_DEV) {
							_lolqLog('[green]_getMatchlistByAccountId(): response for ' + region + '/' + accountId + ' to ' + ip + '[reset]', 1)
						}
						_addToMemCache(cacheKey, JSON.stringify(matchlistMinified), MEMCACHE_MATCHLIST_EXPIRE)
					}

					_incrementRiotApiRequests(id)
				})
			}
		})
	})
}


function _getMatchByGameId(req, res) {
	let region = req.params.region
	let accessToken = req.params.key.substr(5)

	let gameId = req.params.gameId

	let ip = req.connection.remoteAddress;

	_checkAccessToken(accessToken, (err, id) => {
		if(err) {
			if(err == ERRNO_ACCES_DENIED) {
				_lolqLog('[green]_getMatchByGameId():[reset] [red]DENIED REQUEST for ' + region + '/' + gameId + ' from: ' + ip + '[reset]', 1)
			} else if(err == ERRNO_ACCESS_TOKEN_BANNED) {
				_lolqLog('[green]_getMatchByGameId():[reset] [red]BANNED REQUEST for ' + region + '/' + gameId + ' from: ' + ip + '[reset]', 1)
			}
			res.json({"statusCode": err})
			return
		}

		_getMatchdataFromDBCache(region, gameId, (jsonData) => {
			if(jsonData) {
				// Matchdata found in DB cache
				res.json(jsonData)
				_incrementDbCacheHits(id)
				if(process.env.LOLQ_DEV) {
					_lolqLog('[green]_getMatchByGameId():[reset] [cyan](DB CACHE HIT)[reset] [green]response for ' + region + '/' + gameId + ' to ' + ip + '[reset]', 1)
				}
			} else {
				// Matchdata not in DB cache, request from Riot API
				g_kayn.Match.get(gameId).region(region).callback(function(err2, matchinfo) {
					if(err2) {
						res.json(err2)
					} else {
						// Remove unnecessary JSON data to reduce bandwidth consumption
						let matchMinified = _minifyMatchData(matchinfo)
						res.json(matchMinified)
						_addMatchdataToDBCache(region, gameId, matchMinified)
						if(process.env.LOLQ_DEV) {
							_lolqLog('[green]_getMatchByGameId(): response for ' + region + '/' + gameId + ' to ' + ip + '[reset]', 1)
						}
					}
		
					_incrementRiotApiRequests(id)
				})
					}
		})
	})
}


function _checkAccessTokenURLHandler(req, res) {
	let accessToken = req.params.key.substr(5)

	let ip = req.connection.remoteAddress;
	
	_checkAccessToken(accessToken, (err, id) => {
		if(err) {
			if(err == ERRNO_ACCES_DENIED) {
				_lolqLog('[green]_checkAccessTokenURLHandler():[reset] [red]DENIED reply to ' + ip + '[reset]', 1)
				res.send('0')
			} else if(err == ERRNO_ACCESS_TOKEN_BANNED) {
				_lolqLog('[green]_checkAccessTokenURLHandler():[reset] [red]BANNED reply to ' + ip + '[reset]', 1)
				res.send('-1')
			}
			return
		}

		_lolqLog('[green][bright]_checkAccessTokenURLHandler(): valid token reply to ' + ip + '[reset]', 1)
		res.send('1')
	})
}


function _championDataHandler(req, res) {
	let elo = req.params.elo
	let accessToken = req.params.key.substr(5)

	let ip = req.connection.remoteAddress;

	_checkAccessToken(accessToken, (err, id) => {
		if(err) {
			if(err == ERRNO_ACCES_DENIED) {
				_lolqLog('[blue][bright]_championDataHandler():[reset] [red]DENIED REQUEST for ' + elo + ' from: ' + ip + '[reset]', 1)
			} else if(err == ERRNO_ACCESS_TOKEN_BANNED) {
				_lolqLog('[blue][bright]_championDataHandler():[reset] [red]BANNED REQUEST for ' + elo + ' from: ' + ip + '[reset]', 1)
			}
			res.json({"statusCode": err})
			return
		}

		_lolqLog('[blue][bright]_championDataHandler(): response for ' + elo + ' to ' + ip + '[reset]', 1)
		res.json(g_championData[elo])
	})
}



/********************************************************************
*********************************************************************

██████╗ ██████╗ 
██╔══██╗██╔══██╗
██║  ██║██████╔╝
██║  ██║██╔══██╗
██████╔╝██████╔╝
╚═════╝ ╚═════╝ 

*********************************************************************
********************************************************************/

function _checkAccessToken(accessToken, callback) {
	var tbl = MYSQL_USERS_TABLE

	g_sql.query('SELECT id, banned FROM ' + tbl + ' WHERE access_token = ?', [accessToken], function (err, res) {
		if(err) {
			callback(ERRNO_SQL_QUERY_FAILED)
			return
		}

		if(res.length == 0) {
			callback(ERRNO_ACCES_DENIED)
			return
		}

		if(res[0].banned == '1') {
			callback(ERRNO_ACCESS_TOKEN_BANNED)
			return
		}

		callback(false, res[0].id)
	})
}


function _getMatchdataFromDBCache(region, gameId, callback) {
	var tbl = MYSQL_MATCHDATA_CACHE_TABLE
	var regionId = REGION_IDS[region]

	g_sql.query('SELECT jsonData FROM ' + tbl + ' WHERE region = ? AND gameId = ?', [regionId, gameId], function (err, res) {
		if(err || res.length == 0) {
			callback(null)
			return
		}

		callback(JSON.parse(res[0].jsonData))
	})
}

function _addMatchdataToDBCache(region, gameId, jsonData) {
	var tbl = MYSQL_MATCHDATA_CACHE_TABLE
	var regionId = REGION_IDS[region]

	g_sql.query('INSERT INTO ' + tbl + ' (region, gameId, jsonData) VALUES (?, ?, ?)', [regionId, gameId, JSON.stringify(jsonData)], (err, res) => {})
}


function _incrementRiotApiRequests(id) {
	var tbl = MYSQL_USERS_TABLE
	g_sql.query('UPDATE ' + tbl + ' SET riotApiRequests = riotApiRequests + 1 WHERE id = ?', [id], (err, res) => {})
}

function _incrementDbCacheHits(id) {
	var tbl = MYSQL_USERS_TABLE
	g_sql.query('UPDATE ' + tbl + ' SET dbCacheHits = dbCacheHits + 1 WHERE id = ?', [id], (err, res) => {})
}

function _incrementMemCacheHits(id) {
	var tbl = MYSQL_USERS_TABLE
	g_sql.query('UPDATE ' + tbl + ' SET memCacheHits = memCacheHits + 1 WHERE id = ?', [id], (err, res) => {})
}



/********************************************************************
*********************************************************************

███╗   ███╗███████╗███╗   ███╗ ██████╗ █████╗  ██████╗██╗  ██╗███████╗
████╗ ████║██╔════╝████╗ ████║██╔════╝██╔══██╗██╔════╝██║  ██║██╔════╝
██╔████╔██║█████╗  ██╔████╔██║██║     ███████║██║     ███████║█████╗  
██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║██║     ██╔══██║██║     ██╔══██║██╔══╝  
██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║╚██████╗██║  ██║╚██████╗██║  ██║███████╗
╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝ ╚═════╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝

*********************************************************************
********************************************************************/

function _addToMemCache(key, value, expirationTime) {
	if(g_memCacheEnabled) {
		g_redisClient.set(key, value, 'EX', expirationTime)
	}
}


function _getFromMemCache(key, callback) {
	if(!g_memCacheEnabled) {
		callback(null)
	} else {
		g_redisClient.get(key, (err, reply) => {
			callback(reply)
		})
	}
}



/********************************************************************
*********************************************************************

██████╗██╗  ██╗ █████╗ ███╗   ███╗██████╗ ██████╗  █████╗ ████████╗ █████╗ 
██╔════╝██║  ██║██╔══██╗████╗ ████║██╔══██╗██╔══██╗██╔══██╗╚══██╔══╝██╔══██╗
██║     ███████║███████║██╔████╔██║██████╔╝██║  ██║███████║   ██║   ███████║
██║     ██╔══██║██╔══██║██║╚██╔╝██║██╔═══╝ ██║  ██║██╔══██║   ██║   ██╔══██║
╚██████╗██║  ██║██║  ██║██║ ╚═╝ ██║██║     ██████╔╝██║  ██║   ██║   ██║  ██║
 ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝     ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝

*********************************************************************
********************************************************************/

function _readChampionData(cb) {
	var elos = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUMPLUS']

	let error = false

	if(process.env.LOLQ_DEV) {
		_lolqLog('[blue][bright]_readChampionData(): Updating champion datasets to memory[reset]')
	}

	async.forEachOfSeries(elos, function (elo, idx, callback) {
		let file = path.join(CHAMPIONDATA_DIR, 'championGG_dataset_' + elo + '.json')
		fs.readFile(file, 'utf8', function (err, data) {
			if(err) {
				_lolqLog('[blue][bright]_readChampionData():[reset] [red]Could not read ' + file + ', error: ' + err + '[reset]')
				error = true
				callback()
				return
			}

			// Read JSON
			try {
				let championData = JSON.parse(data)
				if(	!championData.hasOwnProperty('champions') || !championData.champions.length
					|| championData.champions.length <= 100)
				{
					_lolqLog('[blue][bright]_initChampionData():[reset] [red]ERROR: championData for elo ' + elo + ' contains less than 100 champions[reset]')
					error = true
				} else {
					g_championData[elo] = championData
				}
			} catch(e) {
				_lolqLog('[blue][bright]_readChampionData():[reset] [red]Could not JSON.parse() data from ' + file + ', error: ' + e + '[reset]')
				error = true
			} finally {
				callback()
			}
		})
	}, function(err) {
		cb(error)
	})
}



/********************************************************************
*********************************************************************

███╗   ███╗██╗███╗   ██╗██╗███████╗██╗   ██╗
████╗ ████║██║████╗  ██║██║██╔════╝╚██╗ ██╔╝
██╔████╔██║██║██╔██╗ ██║██║█████╗   ╚████╔╝ 
██║╚██╔╝██║██║██║╚██╗██║██║██╔══╝    ╚██╔╝  
██║ ╚═╝ ██║██║██║ ╚████║██║██║        ██║   
╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝╚═╝        ╚═╝   

*********************************************************************
********************************************************************/

function _minifySummonerData(summonerData) {
	return {
		"id": summonerData.id,
		"n": summonerData.name,
		"aId": summonerData.accountId
	}
}


function _minifyLeaguesData(leaguesData) {
	let leagues = {}

	for(let j = 0, len = leaguesData.length; j < len; j++) {
		if(leaguesData[j].queueType == 'RANKED_SOLO_5x5') {
			if(leaguesData[j].tier == 'MASTER' || leaguesData[j].tier == 'CHALLENGER') {
				leagues['t'] = leaguesData[j].tier
			} else {
				leagues['t'] = leaguesData[j].tier + ' ' + leaguesData[j].rank
			}
			leagues['lp'] = leaguesData[j].leaguePoints
			leagues['w'] = leaguesData[j].wins
			leagues['l'] = leaguesData[j].losses

			// Check for promotion series
			if(leaguesData[j].hasOwnProperty('miniSeries')) {
				leagues['ms'] = leaguesData[j].miniSeries.progress
			}

			break
		}
	}

	return leagues
}


function _minifyMatchlistData(matchlistData) {
	let matchlist = []

	for(let j = 0, len = matchlistData.matches.length; j < len; j++) {
		let match = {
			"id": matchlistData.matches[j].gameId,
			"ts": matchlistData.matches[j].timestamp,
			"l": matchlistData.matches[j].lane,
			"r": matchlistData.matches[j].role,
			"c": matchlistData.matches[j].champion
		}
		matchlist.push(match)
	}

	return matchlist
}


function _minifyMatchData(matchData) {
	let res = {
		"pId": [],
		"p": [],
		"g": matchData.gameDuration
	}

	for(let j = 0, len = matchData.participantIdentities.length; j < len; j++) {
		let id = {
			"id": matchData.participantIdentities[j].participantId,
			"p": {
				"aId": matchData.participantIdentities[j].player.currentAccountId
			}
		}
		res['pId'].push(id)
	}

	// Find stats
	for(let j = 0, len = matchData.participants.length; j < len; j++) {
		let participant = {
			"id": matchData.participants[j].participantId,
			"cId": matchData.participants[j].championId,
			"s": {
				"k": matchData.participants[j].stats.kills,
				"d": matchData.participants[j].stats.deaths,
				"a": matchData.participants[j].stats.assists,
				"w": matchData.participants[j].stats.win ? 1 : 0,
			}
		}
		res['p'].push(participant)
	}

	return res
}



/********************************************************************
*********************************************************************

██╗      ██████╗  ██████╗  ██████╗ ██╗███╗   ██╗ ██████╗ 
██║     ██╔═══██╗██╔════╝ ██╔════╝ ██║████╗  ██║██╔════╝ 
██║     ██║   ██║██║  ███╗██║  ███╗██║██╔██╗ ██║██║  ███╗
██║     ██║   ██║██║   ██║██║   ██║██║██║╚██╗██║██║   ██║
███████╗╚██████╔╝╚██████╔╝╚██████╔╝██║██║ ╚████║╚██████╔╝
╚══════╝ ╚═════╝  ╚═════╝  ╚═════╝ ╚═╝╚═╝  ╚═══╝ ╚═════╝ 

*********************************************************************
********************************************************************/

function _initLogging() {
	_lolqLog()
	_lolqLog('[bright]   ___       ________  ___       ________[reset]')
	_lolqLog("[bright]  |\\  \\     |\\   __  \\|\\  \\     |\\   __  \\[reset]")
	_lolqLog("[bright]  \\ \\  \\    \\ \\  \\|\\  \\ \\  \\    \\ \\  \\|\\  \\[reset]")
	_lolqLog("[bright]   \\ \\  \\    \\ \\  \\\\\\  \\ \\  \\    \\ \\  \\\\\\  \\[reset]")
	_lolqLog("[bright]    \\ \\  \\____\\ \\  \\\\\\  \\ \\  \\____\\ \\  \\\\\\  \\[reset]")
	_lolqLog("[bright]     \\ \\_______\\ \\_______\\ \\_______\\ \\_____  \\[reset]")
	_lolqLog("[bright]      \\|_______|\\|_______|\\|_______|\\|___| \\__\\[reset]")
	_lolqLog("[bright]                                          \\|__|[reset]")
	_lolqLog()
	_lolqLog("[bright]       API proxy and data server[reset]")
	_lolqLog()
	_lolqLog("[bright]       Copyright (C) 2018  Ric <ric@lolq.org>[reset]")
	_lolqLog("[bright]       This program comes with ABSOLUTELY NO WARRANTY; for details see LOLQ-LICENSE.txt[reset]")
	_lolqLog("[bright]       This is free software, and you are welcome to redistribute it under certain conditions; for details see LOLQ-LICENSE.txt[reset]")
	_lolqLog()
	_lolqLog()
	_lolqLog('[green]LoLQ server V' + serverVersion + ' starting...[reset]')
	_lolqLog()
	_lolqLog('[magenta]Express[reset]: ' + expressVersion)
	_lolqLog('[magenta]Helmet[reset]: ' + helmetVersion)
	_lolqLog('[magenta]MySQL[reset]: ' + mysqlVersion)
	_lolqLog('[magenta]Redis[reset]: ' + redisVersion)
	_lolqLog('[magenta]Kayn[reset]: ' + kaynVersion)
	_lolqLog()
}

function _endLogging() {
	_lolqLog()
	_lolqLog('[red]LoLQ server shutting down[reset]')
	_lolqLog()
}

function _lolqLog(msg, indent) {
	if(!msg) msg = ''

	if(!indent) indent = 0
	else indent = indent * 4

	var pad = new Array(indent + 1).join(' ');

	var time = _getTime()

	// Replace colors
	var con = msg.replace(/\[red\]/g, '\x1b[31m')
	con = con.replace(/\[bright\]/g, '\x1b[1m')
	con = con.replace(/\[green\]/g, '\x1b[32m')
	con = con.replace(/\[yellow\]/g, '\x1b[33m')
	con = con.replace(/\[blue\]/g, '\x1b[34m')
	con = con.replace(/\[blue-white\]/g, '\x1b[34m\x1b[47m')
	con = con.replace(/\[white-blue\]/g, '\x1b[37m\x1b[44m')
	con = con.replace(/\[magenta\]/g, '\x1b[35m')
	con = con.replace(/\[cyan\]/g, '\x1b[36m')
	con = con.replace(/\[white\]/g, '\x1b[37m')
	con = con.replace(/\[reset\]/g, '\x1b[0m')
	
	console.log('[' + time + '] ' + pad + con)
}

function addZero(i) {
    if (i < 10) {
        i = "0" + i;
    }
    return i;
}

function _getTime() {
    var d = new Date();
    var h = addZero(d.getHours());
    var m = addZero(d.getMinutes());
    var s = addZero(d.getSeconds());
    return h + ":" + m + ":" + s;
}