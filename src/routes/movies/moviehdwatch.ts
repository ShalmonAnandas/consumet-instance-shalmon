import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { MOVIES } from '@consumet/extensions';
import { IMovieResult, ISearch, StreamingServers } from '@consumet/extensions/dist/models';

import cache from '../../utils/cache';
import { redis } from '../../main';
import { Redis } from 'ioredis';
import axios from 'axios';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const movieshd = new MOVIES.MovieHdWatch();

  async function getBase64ImageFromUrl(imageUrl: string): Promise<string | null> {
    try {
      const image = await axios.get(imageUrl.replace("250x400", "1000x1600"), { responseType: 'arraybuffer' });
      const buffer = Buffer.from(image.data, 'binary');
      const base64Image = buffer.toString('base64');
      return `data:image/jpeg;base64,${base64Image}`;
    } catch (error) {
      console.error('Error fetching image:', error);
      return null;
    }
  }

  async function updateMoviesWithBase64Images(movies: IMovieResult[]): Promise<IMovieResult[]> {
    const updatedMovies = await Promise.all(movies.map(async (movie) => {
      const base64Image = await getBase64ImageFromUrl(movie.image!);
      return { ...movie, base64Image };
    }));
    return updatedMovies;
  }

  async function updateMoviesWithBase64ImagesForSearch(movies: ISearch<IMovieResult>): Promise<ISearch<IMovieResult>> {
    const updatedMovies = await Promise.all(movies.results.map(async (movie) => {
      const base64Image = await getBase64ImageFromUrl(movie.image!);
      return { ...movie, base64Image };
    }));
    movies["results"] = updatedMovies;
    return movies;
  }

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro:
        "Welcome to the MoviesHDWatch provider: check out the provider's website @ https://movieshd.to/",
      routes: ['/:query', '/info', '/watch', '/recent-shows', '/recent-movies', '/trending', '/servers'],
      documentation: 'https://docs.consumet.org/#tag/movieshd',
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = decodeURIComponent((request.params as { query: string }).query);

    const page = (request.query as { page: number }).page;

    let res = redis
      ? await cache.fetch(
        redis as Redis,
        `movieshd:${query}:${page}`,
        async () => await movieshd.search(query, page ? page : 1),
        60 * 60 * 6,
      )
      : await movieshd.search(query, page ? page : 1);

    let updatedMovies = await updateMoviesWithBase64ImagesForSearch(res);

    reply.status(200).send(updatedMovies);
  });

  fastify.get('/recent-shows', async (request: FastifyRequest, reply: FastifyReply) => {
    let res = redis
      ? await cache.fetch(
        redis as Redis,
        `movieshd:recent-shows`,
        async () => await movieshd.fetchRecentTvShows(),
        60 * 60 * 3,
      )
      : await movieshd.fetchRecentTvShows();

    let updatedResults = await updateMoviesWithBase64Images(res);

    reply.status(200).send(updatedResults);
  });

  fastify.get('/recent-movies', async (request: FastifyRequest, reply: FastifyReply) => {
    let res = redis
      ? await cache.fetch(
        redis as Redis,
        `movieshd:recent-movies`,
        async () => await movieshd.fetchRecentMovies(),
        60 * 60 * 3,
      )
      : await movieshd.fetchRecentMovies();

    let updatedResults = await updateMoviesWithBase64Images(res);

    reply.status(200).send(updatedResults);
  });

  fastify.get('/trending', async (request: FastifyRequest, reply: FastifyReply) => {
    const type = (request.query as { type: string }).type;
    try {
      if (!type) {
        const res = [
          ...((await movieshd.fetchTrendingMovies()).slice(0, 7)),
          ...((await movieshd.fetchTrendingTvShows()).slice(0, 7)),
        ];
        let updatedResults = await updateMoviesWithBase64Images(res);

        reply.status(200).send(updatedResults);
      }

      let res = redis
        ? await cache.fetch(
          redis as Redis,
          `movieshd:trending:${type}`,
          async () =>
            type === 'tv'
              ? await movieshd.fetchTrendingTvShows()
              : await movieshd.fetchTrendingMovies(),
          60 * 60 * 3,
        )
        : type === 'tv'
          ? await movieshd.fetchTrendingTvShows()
          : await movieshd.fetchTrendingMovies();


      let updatedResults = await updateMoviesWithBase64Images(res);

      reply.status(200).send(updatedResults);
    } catch (error) {
      reply.status(500).send({
        message:
          'Something went wrong. Please try again later. or contact the developers.',
      });
    }
  });

  fastify.get('/info', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.query as { id: string }).id;

    if (typeof id === 'undefined')
      return reply.status(400).send({
        message: 'id is required',
      });

    try {
      let res = redis
        ? await cache.fetch(
          redis as Redis,
          `movieshd:info:${id}`,
          async () => await movieshd.fetchMediaInfo(id),
          60 * 60 * 3,
        )
        : await movieshd.fetchMediaInfo(id);

      let updatedImage = await getBase64ImageFromUrl(res.image!);
      res.image = updatedImage!;

      let updatedCover = await getBase64ImageFromUrl(res.cover!);
      res.cover = updatedCover!;

      reply.status(200).send(res);
    } catch (err) {
      reply.status(500).send({
        message:
          'Something went wrong. Please try again later. or contact the developers.',
      });
    }
  });

  fastify.get('/watch', async (request: FastifyRequest, reply: FastifyReply) => {
    const episodeId = (request.query as { episodeId: string }).episodeId;
    const mediaId = (request.query as { mediaId: string }).mediaId;
    const server = (request.query as { server: StreamingServers }).server;

    if (typeof episodeId === 'undefined')
      return reply.status(400).send({ message: 'episodeId is required' });
    if (typeof mediaId === 'undefined')
      return reply.status(400).send({ message: 'mediaId is required' });

    if (server && !Object.values(StreamingServers).includes(server))
      return reply.status(400).send({ message: 'Invalid server query' });

    try {
      let res = redis
        ? await cache.fetch(
          redis as Redis,
          `movieshd:watch:${episodeId}:${mediaId}:${server}`,
          async () => await movieshd.fetchEpisodeSources(episodeId, mediaId, server),
          60 * 30,
        )
        : await movieshd.fetchEpisodeSources(episodeId, mediaId, server);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Please try again later.' });
    }
  });

  fastify.get('/servers', async (request: FastifyRequest, reply: FastifyReply) => {
    const episodeId = (request.query as { episodeId: string }).episodeId;
    const mediaId = (request.query as { mediaId: string }).mediaId;
    try {
      let res = redis
        ? await cache.fetch(
          redis as Redis,
          `movieshd:servers:${episodeId}:${mediaId}`,
          async () => await movieshd.fetchEpisodeServers(episodeId, mediaId),
          60 * 30,
        )
        : await movieshd.fetchEpisodeServers(episodeId, mediaId);

      reply.status(200).send(res);
    } catch (error) {
      reply.status(500).send({
        message:
          'Something went wrong. Please try again later. or contact the developers.',
      });
    }
  });

  // fastify.get('/country/:country', async (request: FastifyRequest, reply: FastifyReply) => {
  //   const country = (request.params as { country: string }).country;
  //   const page = (request.query as { page: number }).page ?? 1;
  //   try {
  //     let res = redis
  //       ? await cache.fetch(
  //         redis as Redis,
  //         `movieshd:country:${country}:${page}`,
  //         async () => await movieshd.fetchByCountry(country, page),
  //         60 * 60 * 3,
  //       )
  //       : await movieshd.fetchByCountry(country, page);

  //     reply.status(200).send(res);
  //   } catch (error) {
  //     reply.status(500).send({
  //       message:
  //         'Something went wrong. Please try again later. or contact the developers.',
  //     });
  //   }
  // });


  // fastify.get('/genre/:genre', async (request: FastifyRequest, reply: FastifyReply) => {
  //   const genre = (request.params as { genre: string }).genre;
  //   const page = (request.query as { page: number }).page ?? 1;
  //   try {
  //     let res = redis
  //       ? await cache.fetch(
  //         redis as Redis,
  //         `movieshd:genre:${genre}:${page}`,
  //         async () => await movieshd.fetchByGenre(genre, page),
  //         60 * 60 * 3,
  //       )
  //       : await movieshd.fetchByGenre(genre, page);

  //     reply.status(200).send(res);
  //   } catch (error) {
  //     reply.status(500).send({
  //       message:
  //         'Something went wrong. Please try again later. or contact the developers.',
  //     });
  //   }
  // });
};
export default routes;
