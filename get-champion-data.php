<?php $_scriptStart = microtime(true);

//
//   ___       ________  ___       ________
//  |\  \     |\   __  \|\  \     |\   __  \
//  \ \  \    \ \  \|\  \ \  \    \ \  \|\  \
//   \ \  \    \ \  \\\  \ \  \    \ \  \\\  \
//    \ \  \____\ \  \\\  \ \  \____\ \  \\\  \
//     \ \_______\ \_______\ \_______\ \_____  \
//      \|_______|\|_______|\|_______|\|___| \__\
//                                          \|__|
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
// This script can be run from a cronjob to update the champion data JSON
// files for LoLQ
//

//
// You should have a .lolq-server-config.json in your home directory with the following:
//
// {
//     RIOT_API_KEY: "<riot api key>",
//     CHAMPIONGG_API_KEY: "<champion.gg api key>"
// }
//

$_config_json			= json_decode(file_get_contents($_SERVER["HOME"] . "/.lolq-server-config.json"), true);
$_RIOTAPIKey			= $_config_json['RIOT_API_KEY'];
$_championGGAPIKey		= $_config_json['CHAMPIONGG_API_KEY'];

// Prefix for the files output by this script. Final file will be:
//		$_outputFilePrefix{ELO}.json
$_outputFilePrefix		= $_config_json['CHAMPIONDATA_DIR'] . "/championGG_dataset_";

$_RIOTchampionDataFile	= $_config_json['CHAMPIONDATA_DIR'] . "/_RIOT_championData.json";
$_RIOTchampionDataURL	= "https://euw1.api.riotgames.com/lol/static-data/v3/champions?locale=en_US&dataById=false&api_key=" . $_RIOTAPIKey;

$_matchupsMinCount		= 100;	// Minimum number of matchups a champion has to have played
								// against other champion to be counted in best/worst winrate
								// stats



/********************************************************************
*********************************************************************

██████╗  █████╗ ████████╗ █████╗     ████████╗██╗   ██╗██████╗ ███████╗███████╗
██╔══██╗██╔══██╗╚══██╔══╝██╔══██╗    ╚══██╔══╝╚██╗ ██╔╝██╔══██╗██╔════╝██╔════╝
██║  ██║███████║   ██║   ███████║       ██║    ╚████╔╝ ██████╔╝█████╗  ███████╗
██║  ██║██╔══██║   ██║   ██╔══██║       ██║     ╚██╔╝  ██╔═══╝ ██╔══╝  ╚════██║
██████╔╝██║  ██║   ██║   ██║  ██║       ██║      ██║   ██║     ███████╗███████║
╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝       ╚═╝      ╚═╝   ╚═╝     ╚══════╝╚══════╝

These will be serialized into JSON data with json_encode()

*********************************************************************
********************************************************************/


class ChampionDataSet {
	public $patch		= 0;		// Current patch at champion.GG
	public $lastUpdate	= 0;		// Last update at champion.GG

	public $riotVersion	= 0;		// Version from RIOT API (for icon image)

	public $elo			= "";

	public $champions	= [];		// Array of ChampionInfo objects

	function __construct($elo, $riotVersion) {
		$this->elo = $elo;
		$this->riotVersion = $riotVersion;
	}
}


class ChampionInfo {
	public $id		= 0;			// Champion ID
	public $name	= "";			// Champion name
	public $key		= "";			// Champion "key" (for icon image)

	public $roles	= [];			// Array of RoleInfo objects
}


class RoleInfo {
	public $role		= "";	// Name of this role, e.g. "TOP", or "MID"
	public $roleRate	= 0;	// Rate this champion is played on this role, note that
								// champion.GG will only return roles with role rate of
								// atleast 11%

	public $rank		= 0;	// "Overall performance score" from the champion.GG champion
								// page

	public $rankPos		= 0;	// Total number of positions for the "overall perf. score"

	public $rankDelta	= 0;	// Change in overall rank since last patch

	public $winRate		= 0;
	public $playRate	= 0;
	public $banRate		= 0;

	public $adDmg		= 0;
	public $apDmg		= 0;
	public $trueDmg		= 0;

	public $bestWRs		= [];	// Array of WinrateInfo objects
	public $worstWRs	= [];	// Array of WinrateInfo objects
}


class WinrateInfo {
	public $winrate	= 0;	// Winrate against this champ
	public $name	= "";	// Champion name
	public $key		= "";	// Champion key (for icon image)
}



/********************************************************************
*********************************************************************

█████╗ ██████╗ ██████╗ 
██╔══██╗██╔══██╗██╔══██╗
███████║██████╔╝██████╔╝
██╔══██║██╔═══╝ ██╔═══╝ 
██║  ██║██║     ██║     
╚═╝  ╚═╝╚═╝     ╚═╝     

*********************************************************************
********************************************************************/


echo "\n" . __FILE__ . " starting at " . date('H:i:s \o\n l jS \of F Y') . "\n\n";


/********************************************************************
 * Fetch champion listing from RIOT API
 *******************************************************************/
echo "[RIOT] Loading champion list from RIOT...\n";
$riotChampionDataJSON = _loadRIOTchampionData();
if($riotChampionDataJSON === false) {
	_appError("ERROR: APP MAIN line " . __LINE__ . ": _loadRIOTchampionData() failed!\n");
}

$riotObj = json_decode($riotChampionDataJSON);
if($riotObj === NULL) {
	_appError("ERROR: APP MAIN line " . __LINE__ . ": json_decode() failed for RIOT API champion data!\n");
}

if(property_exists($riotObj, "status")) {
	// Invalid RIOT API key
	_appError("ERROR: APP MAIN line " . __LINE__ . ": Invalid RIOT API key!\n");
}

echo "[RIOT] Champion list succesfully loaded\n\n";


/********************************************************************
 * Fetch data sets for all ELOs and write to file
 *******************************************************************/

$bronzeDataSet = _getChampionDataSet($riotObj, "BRONZE");
if(_writeDataSetToFile($bronzeDataSet, "BRONZE") === false) {
	_appError("ERROR: APP MAIN line " . __LINE__ . ": failed to write BRONZE dataset to file!\n");
}

echo "\nWaiting 11 seconds before next dataset for champion.GG rate limits...\n\n";
usleep(11000000);

$silverDataSet = _getChampionDataSet($riotObj, "SILVER");
if(_writeDataSetToFile($silverDataSet, "SILVER") === false) {
	_appError("ERROR: APP MAIN line " . __LINE__ . ": failed to write SILVER dataset to file!\n");
}

echo "\nWaiting 11 seconds before next dataset for champion.GG rate limits...\n\n";
usleep(11000000);

$goldDataSet = _getChampionDataSet($riotObj, "GOLD");
if(_writeDataSetToFile($goldDataSet, "GOLD") === false) {
	_appError("ERROR: APP MAIN line " . __LINE__ . ": failed to write GOLD dataset to file!\n");
}

echo "\nWaiting 11 seconds before next dataset for champion.GG rate limits...\n\n";
usleep(11000000);

$platinumPlusDataSet = _getChampionDataSet($riotObj, "PLATINUM+");
if(_writeDataSetToFile($platinumPlusDataSet, "PLATINUM+") === false) {
	_appError("ERROR: APP MAIN line " . __LINE__ . ": failed to write PLATINUM+ dataset to file!\n");
}


/********************************************************************
 * Script finished!
 *******************************************************************/
$_timeElapsed = microtime(true) - $_scriptStart;

echo "\n" . __FILE__ . " completed at " . date('H:i:s') . " (script runtime: ${_timeElapsed} seconds)\n\n";

exit(0);



/********************************************************************
*********************************************************************

███████╗██╗   ██╗███╗   ██╗ ██████╗
██╔════╝██║   ██║████╗  ██║██╔════╝
█████╗  ██║   ██║██╔██╗ ██║██║     
██╔══╝  ██║   ██║██║╚██╗██║██║     
██║     ╚██████╔╝██║ ╚████║╚██████╗
╚═╝      ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝

*********************************************************************
********************************************************************/


/*
 * Fetches champion data from champion.GG API for all champs in
 * $riotObj->data and for the specified ELO.
 * 
 * ELO can be "BRONZE", "SILVER", "GOLD" or "PLATINUM+"
 */
function _getChampionDataSet(&$riotObj, $elo) {
	$championDataSet = new ChampionDataSet($elo, $riotObj->version);

	echo "[champion.GG] Fetching dataset for ELO: " . $elo . "\n";

	if(_getChampionGGinfo($championDataSet->patch,
						  $championDataSet->lastUpdate,
						  $elo) === false)
	{
		return false;
	}

	// Loop through each champion returned by RIOT's API
	foreach($riotObj->data as $championData) {
		$champion = new ChampionInfo();

		$champion->id = $championData->id;
		$champion->name = $championData->name;
		$champion->key = $championData->key;

		// Get champion.GG data, roles and riotObj passed as reference
		$res = _getChampionGGData($champion->id, $champion->roles, $elo, $riotObj);

		if($res === false) {
			// TODO: Figure out if we need to fatalerror if there are no roles (yet?)
			// for this champion

			// Exit for now
			_appError("ERROR: No roles found at champion.GG API for " . $champion->name . " (id: " . $champion->id . ") at elo " . $elo . "\n");
		} 
		
		// Add to champion data set
		$championDataSet->champions[] = $champion;

		// Sleep between runs to not overload champion.GG API rate limits
		usleep(250000);
	}

	echo "\n[champion.GG] Done!\n\n";

	return $championDataSet;
}


/*
 * Writes a ChampionDataSet object to file as JSON string.
 */
function _writeDataSetToFile(&$dataset, $elo) {
	global $_outputFilePrefix;

	$_elo = $elo;

	if($elo == "PLATINUM+") $_elo = "PLATINUMPLUS";

	$file = $_outputFilePrefix . $_elo . ".json";
	$tmpFile = $file . ".tmp";

	echo "Writing ${elo} dataset to ${file}...\n";

	$fp = fopen($tmpFile, 'w');
	if($fp === false) {
		echo "ERROR: _writeDataSetToFile() line " . __LINE__ . ": fopen(${file}) for writing failed\n";
		return false;
	}

	$json = json_encode($dataset, JSON_UNESCAPED_SLASHES);
	if($json === false) {
		echo "ERROR: _writeDataSetToFile() line " . __LINE__ . ": json_encode() failed for ${elo} dataset\n";
		return false;
	}

	if(fwrite($fp, $json) === false) {
		echo "ERROR: _writeDataSetToFile() line " . __LINE__ . ": fwrite(${file}) failed\n";
		return false;
	}

	if(fclose($fp) === false) {
		echo "ERROR: _writeDataSetToFile() line " . __LINE__ . ": fclose(${file}) failed\n";
		return false;
	}

	if(rename($tmpFile, $file) === false) {
		echo "ERROR: _writeDataSetToFile() line " . __LINE__ . ": rename(${tmpFile}, ${file}) failed\n";
		return false;
	}

	echo "Done!\n";

	return true;
}


/*
 * Fetches data from champion.GG api for the specified champ ID / ELO
 * and stores it in $roles (reference to a RoleInfo object)
 */
function _getChampionGGData($id, &$roles, $elo, &$riotObj) {
	global $_championGGAPIKey;

	echo "${id}...";

	$url = "";

	if($elo == "PLATINUM+") {
		$url = "http://api.champion.gg/v2/champions/${id}/?champData=positions,matchups,damage&api_key=" . $_championGGAPIKey;
	} else {
		$url = "http://api.champion.gg/v2/champions/${id}/?elo=${elo}&champData=positions,matchups,damage&api_key=" . $_championGGAPIKey;
	}

	$json = file_get_contents($url);
	if($json === false) {
		echo "ERROR: _getChampionGGData() line " . __LINE__ . ": file_get_contents() failed for champion ID ${id} at ELO ${elo}\n";
		return false;
	}

	$obj = json_decode($json);
	if($obj === NULL) {
		echo "ERROR: _getChampionGGData() line " . __LINE__ . ": json_decode() failed for champion ID ${id} at ELO ${elo}\n";
		return false;
	}

	if(empty($obj)) {
		echo "ERROR: _getChampionGGData() line " . __LINE__ . ": returned JSON data contains no roles for champion ID ${id} at ELO ${elo}\n";
		return false;
	}

	// Sort by role rate, highest first
	usort($obj, function ($item1, $item2) {
		return $item2->percentRolePlayed <=> $item1->percentRolePlayed;
	});

	foreach($obj as $role_data) {
		$role = new RoleInfo();

		$role->role = $role_data->role;

		$role->roleRate = truncate($role_data->percentRolePlayed * 100, 2);

		if(	property_exists($role_data->positions, "overallPerformanceScore") &&
			$role_data->positions->overallPerformanceScore != null)
		{
			$role->rank = $role_data->positions->overallPerformanceScore;
		}
		if(	property_exists($role_data->positions, "totalPositions") &&
			$role_data->positions->totalPositions != null)
		{
			$role->rankPos = $role_data->positions->totalPositions;
		}
		if(	property_exists($role_data->positions, "overallPerformanceScoreDelta") &&
			$role_data->positions->overallPerformanceScoreDelta != null)
		{
			$role->rankDelta = $role_data->positions->overallPerformanceScoreDelta;
		}

		$role->winRate = truncate($role_data->winRate * 100, 2);
		$role->playRate = truncate($role_data->playRate * 100, 2);
		$role->banRate = truncate($role_data->banRate * 100, 2);

		$role->adDmg = truncate($role_data->damageComposition->percentPhysical * 100, 2);
		$role->apDmg = truncate($role_data->damageComposition->percentMagical * 100, 2);
		$role->trueDmg = truncate($role_data->damageComposition->percentTrue * 100, 2);

		$str = $role->role;

		if(	property_exists($role_data, "matchups") &&
			property_exists($role_data->matchups, $str) &&
			!empty($role_data->matchups->$str))
		{
			$role->bestWRs = _getWinrates($id, $role_data->matchups->$str, $riotObj);
			$role->worstWRs = _getWinrates($id, $role_data->matchups->$str, $riotObj, true);
		}

		$roles[] = $role;
	}

	return true;
}


/*
 * Returns top10 best/worst winrates for the given champion ID from the
 * champion.GG matchups JSON for that champ
 */
function _getWinrates($id, &$matchups, &$riotObj, $worst = false) {
	global $_matchupsMinCount;

	$result = [];

	foreach($matchups as $matchup) {
		// Only count matchups with atleast $_matchupsMinCount games played
		if($matchup->count > $_matchupsMinCount) {
			$winrates = new WinrateInfo();

			if($matchup->champ1_id == $id) {
				$winrates->winrate	= truncate($matchup->champ1->winrate * 100, 2);
				$winrates->name		= _getChampionNameById($matchup->champ2_id, $riotObj);
				$winrates->key		= _getChampionKeyById($matchup->champ2_id, $riotObj);
				$result[] = $winrates;
			} else {
				$winrates->winrate	= truncate($matchup->champ2->winrate * 100, 2);
				$winrates->name		= _getChampionNameById($matchup->champ1_id, $riotObj);
				$winrates->key		= _getChampionKeyById($matchup->champ1_id, $riotObj);
				$result[] = $winrates;
			}
		}
	}

	// Sort by winrate, highest first
	usort($result,
		function($a, $b) {
			$result = 0;
			if ($a->winrate < $b->winrate) {
				$result = 1;
			} else if ($a->winrate > $b->winrate) {
				$result = -1;
			}
			return $result; 
		}
	);

	// If worst winratest requested, reverse the array
	if($worst) {
		$result = array_reverse($result);
	}

	// Return top10
	return array_slice($result, 0, 10, true);
}


/*
 * Gets the champion.GG patch & last-updated info for the specified ELO.
 */
function _getChampionGGinfo(&$patch, &$lastUpdate, $elo) {
	global $_championGGAPIKey;

	$json = "";
	$url = "";

	if($elo == "PLATINUM+") {
		$url = "http://api.champion.gg/v2/general?api_key=${_championGGAPIKey}";
	} else {
		$url = "http://api.champion.gg/v2/general?elo=${elo}&api_key=${_championGGAPIKey}";
	}

	$json = file_get_contents($url);
	if($json === false) {
		echo "ERROR: _getChampionGGinfo() line " . __LINE__ . ": file_get_contents() failed\n";
		return false;
	}

	$obj = json_decode($json);
	if($obj === NULL) {
		echo "ERROR: _getChampionGGinfo() line " . __LINE__ . ": json_decode() failed for champion.GG general site data\n";
		return false;
	}

	if(!property_exists($obj[0], "patch") || !property_exists($obj[0], "lastUpdate")) {
		echo "ERROR: _getChampionGGinfo() line " . __LINE__ . ": returned JSON data doesn't contain patch/lastUpdate info\n";
		return false;
	}

	$patch = $obj[0]->patch;
	$lastUpdate = strtotime($obj[0]->lastUpdate);

	if($lastUpdate === false) {
		echo "ERROR: _getChampionGGinfo() line " . __LINE__ . ": strtotime(" . $obj[0]->lastUpdate . ") failed\n";
		return false;
	}

	return true;
}


/*
 * Loads RIOT champion data JSON from file and returns it as a string
 * 
 * If the file is not found or is older than 1 day, attempt to re-download
 * it from RIOT API.
 */
function _loadRIOTchampionData() {
	global $_RIOTchampionDataFile, $_RIOTchampionDataURL;

	// Check if RIOT champion data JSON file is older than a day (or doesn't exist)
	if(file_exists($_RIOTchampionDataFile) &&
   	  (time() - filemtime($_RIOTchampionDataFile)) < 82800)
	{
		// Not older than day, read & return contents
		$json = file_get_contents($_RIOTchampionDataFile);

		if($json === false) {
			echo "ERROR: _loadRIOTchampionData() line " . __LINE__ . ": file_get_contents() failed\n";
			return false;
		}

		return $json;

	} else {
		// Older than 1 day or file doesn't exist, fetch a new champion list from Riot API
		echo "[RIOT] Champion list JSON file older than 1 day or doesn't exist, redownloading from RIOT API...\n";

		$json = file_get_contents($_RIOTchampionDataURL);
		if($json === false) {
			echo "ERROR: _loadRIOTchampionData() line " . __LINE__ . ": file_get_contents() failed\n";
			return false;
		}

		echo "[RIOT] ... download succesful! writing to ${_RIOTchampionDataFile} ...\n";

		$fp = fopen($_RIOTchampionDataFile, 'w');
		if($fp === false) {
			echo "ERROR: _loadRIOTchampionData() line " . __LINE__ . ": fopen(${_RIOTchampionDataFile}) for writing failed\n";
			return false;
		}

		if(fwrite($fp, $json) === false) {
			echo "ERROR: _loadRIOTchampionData() line " . __LINE__ . ": fwrite(${_RIOTchampionDataFile}) failed\n";
			return false;
		}

		if(fclose($fp) === false) {
			echo "ERROR: _loadRIOTchampionData() line " . __LINE__ . ": fclose(${_RIOTchampionDataFile}) failed\n";
			return false;
		}

		if(touch($_RIOTchampionDataFile) === false) {
			echo "ERROR: _loadRIOTchampionData() line " . __LINE__ . ": touch(${_RIOTchampionDataFile}) failed\n";
			return false;
		}

		echo "[RIOT] .. done!\n";

		return $json;
	}
}


function _getChampionNameById($id, &$riotObj) {
	foreach($riotObj->data as $champion) {
		if($champion->id == $id) {
			return $champion->name;
		}
	}

	return "";
}


function _getChampionKeyById($id, &$riotObj) {
	foreach($riotObj->data as $champion) {
		if($champion->id == $id) {
			return $champion->key;
		}
	}

	return "";
}


function truncate($val, $f="0")
{
    if(($p = strpos($val, '.')) !== false) {
        $val = floatval(substr($val, 0, $p + 1 + $f));
    }
    return $val;
}


/*
 * Exit the app with an error msg
 */
function _appError($errorMsg) {
	echo $errorMsg;
	echo "\n";
	echo "***********************************************************\n";
	echo "*        !! CHAMPION DATA JSON FILE NOT UPDATED !!        *\n";
	echo "***********************************************************\n";
	echo "\n";
	exit(1);
}

?>