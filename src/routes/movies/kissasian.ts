import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { MOVIES } from '@consumet/extensions';
import { IMovieResult, ISearch, StreamingServers } from '@consumet/extensions/dist/models';

import cache from '../../utils/cache';
import { redis } from '../../main';
import { Redis } from 'ioredis';
import axios from 'axios';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const kissasian = new MOVIES.KissAsian();

  async function getBase64ImageFromUrl(imageUrl: string): Promise<string | null> {
    try {
      const image = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(image.data, 'binary');
      const base64Image = buffer.toString('base64');
      return `data:image/jpeg;base64,${base64Image}`;
    } catch (error) {
      console.error('Error fetching image:', error);
      return null;
    }
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
        "Welcome to the kissasianWatch provider: check out the provider's website @ https://kissasian.to/",
      routes: ['/:query', '/info', '/watch', '/recent-shows', '/recent-movies', '/trending', '/servers'],
      documentation: 'https://docs.consumet.org/#tag/kissasian',
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = decodeURIComponent((request.params as { query: string }).query);

    const page = (request.query as { page: number }).page;

    let res = redis
      ? await cache.fetch(
        redis as Redis,
        `kissasian:${query}:${page}`,
        async () => await kissasian.search(query, page ? page : 1),
        60 * 60 * 6,
      )
      : await kissasian.search(query, page ? page : 1);

    let updatedMovies = await updateMoviesWithBase64ImagesForSearch(res);

    reply.status(200).send(updatedMovies);
  });

  // fastify.get('/recent-shows', async (request: FastifyRequest, reply: FastifyReply) => {
  //   let res = redis
  //     ? await cache.fetch(
  //       redis as Redis,
  //       `kissasian:recent-shows`,
  //       async () => await kissasian.fetchRecentTvShows(),
  //       60 * 60 * 3,
  //     )
  //     : await kissasian.fetchRecentTvShows();

  //   reply.status(200).send(res);
  // });

  // fastify.get('/recent-movies', async (request: FastifyRequest, reply: FastifyReply) => {
  //   let res = redis
  //     ? await cache.fetch(
  //       redis as Redis,
  //       `kissasian:recent-movies`,
  //       async () => await kissasian.fetchRecentMovies(),
  //       60 * 60 * 3,
  //     )
  //     : await kissasian.fetchRecentMovies();

  //   reply.status(200).send(res);
  // });

  // fastify.get('/trending', async (request: FastifyRequest, reply: FastifyReply) => {
  //   const type = (request.query as { type: string }).type;
  //   try {
  //     if (!type) {
  //       const res = {
  //         results: [
  //           ...(await kissasian.fetchTrendingMovies()),
  //           ...(await kissasian.fetchTrendingTvShows()),
  //         ],
  //       };
  //       return reply.status(200).send(res);
  //     }

  //     let res = redis
  //       ? await cache.fetch(
  //         redis as Redis,
  //         `kissasian:trending:${type}`,
  //         async () =>
  //           type === 'tv'
  //             ? await kissasian.fetchTrendingTvShows()
  //             : await kissasian.fetchTrendingMovies(),
  //         60 * 60 * 3,
  //       )
  //       : type === 'tv'
  //         ? await kissasian.fetchTrendingTvShows()
  //         : await kissasian.fetchTrendingMovies();

  //     reply.status(200).send(res);
  //   } catch (error) {
  //     reply.status(500).send({
  //       message:
  //         'Something went wrong. Please try again later. or contact the developers.',
  //     });
  //   }
  // });

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
          `kissasian:info:${id}`,
          async () => await kissasian.fetchMediaInfo(id),
          60 * 60 * 3,
        )
        : await kissasian.fetchMediaInfo(id);

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
          `kissasian:watch:${episodeId}:${mediaId}:${server}`,
          async () => await kissasian.fetchEpisodeSources(episodeId, server),
          60 * 30,
        )
        : await kissasian.fetchEpisodeSources(episodeId, server);

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
          `kissasian:servers:${episodeId}:${mediaId}`,
          async () => await kissasian.fetchEpisodeServers(episodeId),
          60 * 30,
        )
        : await kissasian.fetchEpisodeServers(episodeId);

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
  //         `kissasian:country:${country}:${page}`,
  //         async () => await kissasian.fetchByCountry(country, page),
  //         60 * 60 * 3,
  //       )
  //       : await kissasian.fetchByCountry(country, page);

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
  //         `kissasian:genre:${genre}:${page}`,
  //         async () => await kissasian.fetchByGenre(genre, page),
  //         60 * 60 * 3,
  //       )
  //       : await kissasian.fetchByGenre(genre, page);

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
