import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { MOVIES } from '@consumet/extensions';
import { IMovieResult, ISearch, StreamingServers } from '@consumet/extensions/dist/models';

import cache from '../../utils/cache';
import { redis } from '../../main';
import { Redis } from 'ioredis';
import axios from 'axios';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const flixhq = new MOVIES.FlixHQ();

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
        "Welcome to the flixhq provider: check out the provider's website @ https://flixhq.to/",
      routes: ['/:query', '/info', '/watch', '/recent-shows', '/recent-movies', '/trending', '/servers'],
      documentation: 'https://docs.consumet.org/#tag/flixhq',
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = decodeURIComponent((request.params as { query: string }).query);

    const page = (request.query as { page: number }).page;

    let res = redis
      ? await cache.fetch(
        redis as Redis,
        `flixhq:${query}:${page}`,
        async () => await flixhq.search(query, page ? page : 1),
        60 * 60 * 6,
      )
      : await flixhq.search(query, page ? page : 1);

    let updatedReply = await updateMoviesWithBase64ImagesForSearch(res);
    let truncatedRes = updatedReply.results.slice(0, 10);

    updatedReply.results = truncatedRes;

    reply.status(200).send(updatedReply);
  });

  fastify.get('/recent-shows', async (request: FastifyRequest, reply: FastifyReply) => {
    let res = redis
      ? await cache.fetch(
        redis as Redis,
        `flixhq:recent-shows`,
        async () => await flixhq.fetchRecentTvShows(),
        60 * 60 * 3,
      )
      : await flixhq.fetchRecentTvShows();

    let updatedReply = await updateMoviesWithBase64Images(res);

    reply.status(200).send(updatedReply);
  });

  fastify.get('/recent-movies', async (request: FastifyRequest, reply: FastifyReply) => {
    let res = redis
      ? await cache.fetch(
        redis as Redis,
        `flixhq:recent-movies`,
        async () => await flixhq.fetchRecentMovies(),
        60 * 60 * 3,
      )
      : await flixhq.fetchRecentMovies();

    let updatedReply = await updateMoviesWithBase64Images(res);

    reply.status(200).send(updatedReply);
  });

  fastify.get('/trending', async (request: FastifyRequest, reply: FastifyReply) => {
    const type = (request.query as { type: string }).type;
    try {
      if (!type) {
        let res = [
          ...((await flixhq.fetchTrendingMovies()).slice(0, 7)),
          ...((await flixhq.fetchTrendingTvShows()).slice(0, 7)),
        ];

        let updatedReply = await updateMoviesWithBase64Images(res);
        res = updatedReply;

        return reply.status(200).send(res);
      }

      let res = redis
        ? await cache.fetch(
          redis as Redis,
          `flixhq:trending:${type}`,
          async () =>
            type === 'tv'
              ? await flixhq.fetchTrendingTvShows()
              : await flixhq.fetchTrendingMovies(),
          60 * 60 * 3,
        )
        : type === 'tv'
          ? await flixhq.fetchTrendingTvShows()
          : await flixhq.fetchTrendingMovies();

      let updatedReply = await updateMoviesWithBase64Images(res);

      reply.status(200).send(updatedReply);
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
          `flixhq:info:${id}`,
          async () => await flixhq.fetchMediaInfo(id),
          60 * 60 * 3,
        )
        : await flixhq.fetchMediaInfo(id);

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
          `flixhq:watch:${episodeId}:${mediaId}:${server}`,
          async () => await flixhq.fetchEpisodeSources(episodeId, mediaId, server),
          60 * 30,
        )
        : await flixhq.fetchEpisodeSources(episodeId, mediaId, server);

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
          `flixhq:servers:${episodeId}:${mediaId}`,
          async () => await flixhq.fetchEpisodeServers(episodeId, mediaId),
          60 * 30,
        )
        : await flixhq.fetchEpisodeServers(episodeId, mediaId);

      reply.status(200).send(res);
    } catch (error) {
      reply.status(500).send({
        message:
          'Something went wrong. Please try again later. or contact the developers.',
      });
    }
  });

  fastify.get('/country/:country', async (request: FastifyRequest, reply: FastifyReply) => {
    const country = (request.params as { country: string }).country;
    const page = (request.query as { page: number }).page ?? 1;
    try {
      let res = redis
        ? await cache.fetch(
          redis as Redis,
          `flixhq:country:${country}:${page}`,
          async () => await flixhq.fetchByCountry(country, page),
          60 * 60 * 3,
        )
        : await flixhq.fetchByCountry(country, page);

      reply.status(200).send(res);
    } catch (error) {
      reply.status(500).send({
        message:
          'Something went wrong. Please try again later. or contact the developers.',
      });
    }
  });


  fastify.get('/genre/:genre', async (request: FastifyRequest, reply: FastifyReply) => {
    const genre = (request.params as { genre: string }).genre;
    const page = (request.query as { page: number }).page ?? 1;
    try {
      let res = redis
        ? await cache.fetch(
          redis as Redis,
          `flixhq:genre:${genre}:${page}`,
          async () => await flixhq.fetchByGenre(genre, page),
          60 * 60 * 3,
        )
        : await flixhq.fetchByGenre(genre, page);

      reply.status(200).send(res);
    } catch (error) {
      reply.status(500).send({
        message:
          'Something went wrong. Please try again later. or contact the developers.',
      });
    }
  });
};
export default routes;
