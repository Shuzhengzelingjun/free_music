export type Song = {
  id: string;
  title: string;
  artist: string;
  url: string;
  createdAt: string;
};

export type Playlist = {
  id: string;
  name: string;
  songIds: string[];
  createdAt: string;
};

export type Manifest = {
  songs: Song[];
  playlists: Playlist[];
  activePlaylistId: string | null;
  updatedAt: string;
};

export type PublicTrack = Pick<Song, "id" | "title" | "artist" | "url">;

export type PublicPlaylistResponse = {
  playlist: { id: string; name: string } | null;
  songs: PublicTrack[];
  updatedAt: string;
};

export type LibraryResponse = {
  manifest: Manifest;
  storage: "blob" | "local";
  persistent: boolean;
};
