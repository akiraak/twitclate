const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

async function getTwitchAudioUrl(channel) {
  const gqlRes = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: {
      "Client-ID": CLIENT_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `{
        streamPlaybackAccessToken(
          channelName: "${channel}",
          params: {
            platform: "web",
            playerBackend: "mediaplayer",
            playerType: "site"
          }
        ) {
          value
          signature
        }
      }`,
    }),
  });

  if (!gqlRes.ok) {
    throw new Error(`Twitch GQL API error: ${gqlRes.status}`);
  }

  const gqlData = await gqlRes.json();
  const token = gqlData?.data?.streamPlaybackAccessToken;
  if (!token) {
    throw new Error("Stream is offline or access token unavailable");
  }

  const usherUrl = `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8`
    + `?sig=${token.signature}`
    + `&token=${encodeURIComponent(token.value)}`
    + `&player_backend=mediaplayer`
    + `&allow_source=true`
    + `&allow_audio_only=true`;

  const usherRes = await fetch(usherUrl);
  if (!usherRes.ok) {
    throw new Error(`Usher API error: ${usherRes.status}`);
  }

  const playlist = await usherRes.text();

  // Find audio_only variant URL
  const lines = playlist.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("audio_only") || lines[i].includes('VIDEO="audio_only"')) {
      // The URL follows the #EXT-X-STREAM-INF line
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && !lines[j].startsWith("#")) {
          return lines[j].trim();
        }
      }
    }
  }

  // Fallback: use the last (lowest quality) stream URL
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line && !line.startsWith("#")) {
      return line;
    }
  }

  throw new Error("No audio stream URL found in playlist");
}

module.exports = { getTwitchAudioUrl };
