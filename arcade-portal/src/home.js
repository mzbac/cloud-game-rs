import React, { useContext } from "react";
import { Button, Card, Tooltip, Typography } from "antd";
import { ShareAltOutlined } from "@ant-design/icons";
import coverArt from "./assets/ui/game-card-cover.webp";
import "./home.css";
import { AppDataContext } from "./store";
import { useHistory } from "react-router-dom";
import { shareUrl } from "./utils/share";
import { parsePlayerCount } from "./utils/playerCount";

const { Meta } = Card;
function Home() {
  const { state } = useContext(AppDataContext);
  const { games, playerCountsByRoom } = state;
  const history = useHistory();
  const isGamesLoaded = games !== undefined;
  const safePlayerCountsByRoom =
    playerCountsByRoom && typeof playerCountsByRoom === "object"
      ? playerCountsByRoom
      : {};

  const gameEntries =
    games && typeof games === "object" ? Object.entries(games) : [];
  const roomCount = gameEntries.length;
  const totalPlayers = gameEntries.reduce((sum, [roomId]) => {
    return sum + parsePlayerCount(safePlayerCountsByRoom?.[roomId]);
  }, 0);

  return (
    <div className="site-card-wrapper">
      <header className="homeHeader">
        <div className="homeHeaderTop">
          <Typography.Title level={3} className="homeTitle">
            Cloud Arcade
          </Typography.Title>
          <div className="homeStats">
            <div className="homeStatPill">Rooms: {isGamesLoaded ? roomCount : "—"}</div>
            <div className="homeStatPill">Players: {isGamesLoaded ? totalPlayers : "—"}</div>
          </div>
        </div>
        <div className="homeSubtitle">Pick a game room to start playing.</div>
      </header>

      <div className="arcadeCard">
        {isGamesLoaded ? (
          gameEntries.length ? (
            gameEntries.map(([roomId, gameName]) => {
              const playerCount = parsePlayerCount(safePlayerCountsByRoom?.[roomId]);
              return (
                <div className="arcadeCardItem" key={roomId}>
                  <Card
                    className="gameCard"
                    onClick={() => history.push(`/game/${roomId}`)}
                    hoverable
                    cover={<img alt="Arcade cover art" src={coverArt} loading="lazy" />}
                  >
                    <div className="gameCardBody">
                      <Meta title={gameName} description={`Players: ${playerCount}`} />
                      <Tooltip title="Share room link">
                        <Button
                          type="text"
                          className="gameCardShare"
                          icon={<ShareAltOutlined />}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const url = `${window.location.origin}/game/${roomId}`;
                            shareUrl({ title: `Cloud Arcade — ${gameName}`, url });
                          }}
                          aria-label={`Share ${gameName}`}
                        />
                      </Tooltip>
                    </div>
                  </Card>
                </div>
              );
            })
          ) : (
            <div className="arcadeCardItem arcadeCardItemFull">
              <div className="homeLoading">No rooms available.</div>
            </div>
          )
        ) : (
          <div className="arcadeCardItem arcadeCardItemFull">
            <div className="homeLoading">Loading rooms…</div>
          </div>
        )}
      </div>
    </div>
  );
}
export default Home;
